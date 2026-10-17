#pragma once
#include "../../audio-ipc/wave-file.h"
#include "playback-eq.h"
#include <array>
#include <atomic>
#include <cmath>
#include <memory>
#include <thread>
#include <nlohmann/json.hpp>

namespace bb {
// Decoder/pre-read thread owns files; the device callback owns transport and
// consumes all tracks from the same tagged block. UI timing never seeks audio.
class Timeline {
 public:
  using json = nlohmann::json;
  static constexpr unsigned quantum = 512, capacity = 16, trackLimit = 32;
  Timeline(const json& graph, unsigned rate) : rate_(rate), playbackRate_(graph.value("playbackRate", 1.)), blocks_(std::make_unique<Block[]>(capacity)) {
    if (!std::isfinite(playbackRate_) || playbackRate_ < .25 || playbackRate_ > 4) throw std::runtime_error("TIMELINE_RATE_INVALID");
    for (const auto& track : graph.at("tracks")) {
      if (tracks_.size() >= trackLimit) throw std::runtime_error("TIMELINE_RESOURCE_LIMIT");
      auto source = std::make_unique<WaveReader>(std::filesystem::u8path(track.at("path").get<std::string>()));
      if (source->rate() != rate) throw std::runtime_error("TIMELINE_RATE_MISMATCH");
      duration_ = std::max(duration_, source->frames());
      const auto index = tracks_.size(); ids_.push_back(track.at("id"));
      gains_[index].store(track.value("gain", 1.f)); currentGains_[index] = gains_[index].load();
      tracks_.push_back(std::move(source));
    }
    sources_ = std::make_shared<Sources>(); sources_->tracks = tracks_;
    position_.store(frameOf(graph.value("positionMs", 0.))); requestedPosition_.store(position_.load());
    update(graph);
    for (unsigned t = 0; t < trackLimit; ++t) gainStarts_[t] = gainTargets_[t] = currentGains_[t] = gains_[t].load();
    lastGainRevision_ = gainRevision_.load();
    worker_ = std::thread([this] { prefetch(); });
    // Startup priming is outside the device callback.
    for (unsigned i = 0; i < 2000 && write_.load() == 0 && !failed_.load(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    if (!write_.load()) { stop_.store(true); worker_.join(); throw std::runtime_error("TIMELINE_PRIME_FAILED"); }
  }
  ~Timeline() { stop_.store(true); if (worker_.joinable()) worker_.join(); }
  // File opening and ownership changes happen on the control thread. The
  // prefetch thread adopts this immutable snapshot without touching transport.
  void attach(const json& tracks) {
    auto next = std::make_shared<Sources>(*std::atomic_load(&sources_));
    for (const auto& track : tracks) {
      const auto id = track.at("id").get<std::string>();
      auto found = std::find(ids_.begin(), ids_.end(), id);
      const auto index = unsigned(found - ids_.begin());
      if (index >= trackLimit) throw std::runtime_error("TIMELINE_RESOURCE_LIMIT");
      auto source = std::make_shared<WaveReader>(std::filesystem::u8path(track.at("path").get<std::string>()));
      if (source->rate() != rate_) throw std::runtime_error("TIMELINE_RATE_MISMATCH");
      if (found == ids_.end()) { ids_.push_back(id); next->tracks.push_back(source); }
      else next->tracks[index] = source;
    }
    ++next->revision; std::atomic_store(&sources_, next);
  }
  void update(const json& value) {
    if (value.contains("eq")) eq_.configure(value.at("eq"), rate_);
    if (value.contains("masterGain")) master_.store(std::clamp(value.at("masterGain").get<float>(), 0.f, 16.f));
    if (value.contains("tracks")) {
      // An odd revision marks an in-progress control snapshot. Removed tracks
      // retain their source slot, but must no longer contribute to the mix.
      gainRevision_.fetch_add(1, std::memory_order_acq_rel);
      for (auto& gain : gains_) gain.store(0);
      for (const auto& track : value.at("tracks")) for (unsigned i = 0; i < ids_.size(); ++i) if (ids_[i] == track.at("id").get<std::string>()) gains_[i].store(std::clamp(track.value("gain", 1.f), 0.f, 16.f));
      // Old queued blocks keep the old mix until they contain every newly
      // attached source. The callback never waits for the control thread.
      gainSourceRevision_.store(std::atomic_load(&sources_)->revision);
      gainRevision_.fetch_add(1, std::memory_order_release);
    }
    if (value.contains("bpm")) bpm_.store(std::clamp(value.at("bpm").get<double>(), 20., 400.));
    if (value.contains("beatOffsetMs")) beatOffset_.store(value.at("beatOffsetMs").get<double>() / 1000 * rate_ / playbackRate_);
    if (value.contains("metronome")) metronome_.store(value.at("metronome"));
    if (value.contains("loopStartMs") || value.contains("loopEndMs")) {
      const auto start = frameOf(value.value("loopStartMs", 0.)), end = frameOf(value.value("loopEndMs", 0.));
      const auto validEnd = end > start && end <= duration_ ? end : 0;
      if (start != loopStart_.load() || validEnd != loopEnd_.load()) {
        loopStart_.store(start); loopEnd_.store(validEnd); seek(positionMs());
      }
    }
  }
  void play(unsigned beats = 0) { countIn_.store(std::uint64_t(std::min(8u, beats) * 60. / bpm_.load() / playbackRate_ * rate_)); ended_.store(false); playing_.store(true); }
  void pause() { playing_.store(false); countIn_.store(0); }
  void seek(double milliseconds) { const auto target = std::min(duration_, frameOf(milliseconds)); requestedPosition_.store(target); position_.store(target); generation_.fetch_add(1, std::memory_order_release); ended_.store(false); }
  double positionMs() const { return position_.load() * 1000. / rate_ * playbackRate_; }
  std::uint64_t positionFrames() const { return position_.load(); }
  double tempo() const { return bpm_.load() * playbackRate_; }
  double beatOffsetSeconds() const { return beatOffset_.load() / rate_; }
  bool playing() const { return playing_.load() && !countIn_.load(); }
  void mix(float* output, unsigned frames) noexcept {
    if (!playing_.load() || !output) return;
    eq_.beginBlock();
    const double bpm = bpm_.load(), beatFrames = rate_ * 60. / bpm / playbackRate_;
    const auto wanted = generation_.load(std::memory_order_acquire);
    for (unsigned f = 0; f < frames; ++f) {
      const auto countIn = countIn_.load();
      if (countIn) { addClick(output + f * 2, std::uint64_t(beatFrames * 8) - countIn, beatFrames); countIn_.store(countIn - 1); continue; }
      auto r = read_.load(std::memory_order_relaxed);
      unsigned discarded = 0;
      while (r != write_.load(std::memory_order_acquire) && blocks_[r % capacity].generation != wanted && discarded++ < capacity) { read_.store(++r, std::memory_order_release); offset_ = 0; }
      if (r == write_.load(std::memory_order_acquire)) { underruns_.fetch_add(1); break; }
      auto& block = blocks_[r % capacity];
      if (!block.frames) { playing_.store(false); ended_.store(true); break; }
      float left = 0, right = 0;
      const auto revision = gainRevision_.load(std::memory_order_acquire);
      if (!(revision & 1) && revision != lastGainRevision_ && block.sourceRevision >= gainSourceRevision_.load()) {
        std::array<float, trackLimit> targets{};
        for (unsigned t = 0; t < trackLimit; ++t) targets[t] = gains_[t].load();
        if (revision == gainRevision_.load(std::memory_order_acquire)) {
          gainStarts_ = currentGains_; gainTargets_ = targets;
          gainFade_ = 0; lastGainRevision_ = revision;
        }
      }
      gainFade_ = std::min(1.f, gainFade_ + 1.f / (rate_ * .035f));
      for (unsigned t = 0; t < block.trackCount; ++t) {
        currentGains_[t] = gainStarts_[t] + (gainTargets_[t] - gainStarts_[t]) * gainFade_;
        left += block.samples[t][offset_ * 2] * currentGains_[t]; right += block.samples[t][offset_ * 2 + 1] * currentGains_[t];
      }
      currentMaster_ += std::clamp(master_.load() - currentMaster_, -.002f, .002f);
      eq_.sample(left, right);
      // A short ramp after every discontinuity prevents discontinuous seeks.
      if (lastGeneration_ != wanted) { fade_ = 0; lastGeneration_ = wanted; }
      fade_ = std::min(1.f, fade_ + 1.f / 128);
      output[f * 2] += left * currentMaster_ * fade_; output[f * 2 + 1] += right * currentMaster_ * fade_;
      const auto position = block.position + offset_; position_.store(position + 1, std::memory_order_relaxed);
      if (metronome_.load()) addClick(output + f * 2, double(position) - beatOffset_.load(), beatFrames);
      if (++offset_ == block.frames) { offset_ = 0; read_.store(r + 1, std::memory_order_release); }
    }
  }
  json state() const { return {{"positionMs", positionMs()}, {"playing", playing_.load()}, {"ended", ended_.load()}, {"generation", generation_.load()},
    {"countInRemaining", unsigned(std::ceil(countIn_.load() / (rate_ * 60. / bpm_.load() / playbackRate_)))}, {"underruns", underruns_.load()}, {"error", failed_.load() ? "TIMELINE_READ_FAILED" : ""}}; }
 private:
  struct Sources { std::vector<std::shared_ptr<WaveReader>> tracks; unsigned revision = 0; };
  struct Block { std::uint64_t generation = 0, position = 0; unsigned frames = 0, trackCount = 0, sourceRevision = 0; std::array<std::array<float, quantum * 2>, trackLimit> samples{}; };
  std::uint64_t frameOf(double ms) const { return std::uint64_t(std::max(0., ms) / 1000 * rate_ / playbackRate_); }
  void addClick(float* output, double position, double beatFrames) const noexcept {
    if (position < 0) return;
    const auto phase = std::fmod(position, beatFrames); const auto clickFrames = rate_ / 80.;
    if (phase < clickFrames) { const auto beat = std::uint64_t(position / beatFrames); const float click = float(std::sin(2 * 3.141592653589793 * (beat % 4 ? 1080 : 1560) * phase / rate_) * (1 - phase / clickFrames) * .18); output[0] += click; output[1] += click; }
  }
  void prefetch() noexcept {
    std::uint64_t generation = 0, position = 0; bool eof = false; std::array<float, quantum * 2> scratch{};
    try { while (!stop_.load()) {
      const auto desired = generation_.load(std::memory_order_acquire);
      if (generation != desired) { generation = desired; position = requestedPosition_.load(); eof = false; }
      const auto w = write_.load(std::memory_order_relaxed), r = read_.load(std::memory_order_acquire);
      if (w - r == capacity || eof) { std::this_thread::sleep_for(std::chrono::milliseconds(1)); continue; }
      const auto loopEnd = loopEnd_.load(); if (loopEnd && position >= loopEnd) position = loopStart_.load();
      auto& block = blocks_[w % capacity]; block.generation = generation; block.position = position;
      const auto end = loopEnd ? std::min(loopEnd, duration_) : duration_;
      block.frames = unsigned(std::min<std::uint64_t>(quantum, position < end ? end - position : 0));
      const auto sources = std::atomic_load(&sources_);
      block.trackCount = unsigned(sources->tracks.size()); block.sourceRevision = sources->revision;
      for (unsigned t = 0; t < block.trackCount; ++t) {
        sources->tracks[t]->read(position, scratch.data(), block.frames);
        for (unsigned f = 0; f < block.frames; ++f) for (unsigned c = 0; c < 2; ++c) block.samples[t][f * 2 + c] = scratch[f * sources->tracks[t]->channels() + std::min(c, sources->tracks[t]->channels() - 1)];
      }
      position += block.frames; eof = !block.frames; write_.store(w + 1, std::memory_order_release);
    } } catch (...) { failed_.store(true); playing_.store(false); }
  }
  unsigned rate_; double playbackRate_; std::uint64_t duration_ = 0;
  PlaybackEq eq_;
  std::vector<std::shared_ptr<WaveReader>> tracks_; std::vector<std::string> ids_;
  std::shared_ptr<Sources> sources_;
  std::unique_ptr<Block[]> blocks_; std::thread worker_;
  std::array<std::atomic<float>, trackLimit> gains_{}; std::array<float, trackLimit> currentGains_{};
  std::array<float, trackLimit> gainStarts_{}, gainTargets_{};
  std::atomic<unsigned> gainRevision_{0}, gainSourceRevision_{0}; unsigned lastGainRevision_ = 0; float gainFade_ = 1;
  std::atomic<std::uint64_t> read_{0}, write_{0}, position_{0}, requestedPosition_{0}, generation_{1}, loopStart_{0}, loopEnd_{0}, countIn_{0}, underruns_{0};
  std::atomic<bool> stop_{false}, playing_{false}, ended_{false}, failed_{false}, metronome_{false};
  std::atomic<float> master_{1}; std::atomic<double> bpm_{120}, beatOffset_{0};
  unsigned offset_ = 0; std::uint64_t lastGeneration_ = 0; float currentMaster_ = 1, fade_ = 0;
};
}
