#pragma once
#include "../../audio-ipc/wave-file.h"
#include "../../audio-ipc/shared-audio.h"
#include "../../audio-ipc/worker-wait.h"
#include "effects.h"
#include <signalsmith-stretch/signalsmith-stretch.h>
#include <chrono>
#include <thread>
#include <sstream>
#include <iostream>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace bb {
// Used by both desktop engines. Only a bounded block of the original capture
// is read/processed. Silence and placement are timeline coordinates, not files.
// All of this runs on a decoder/prefetch thread, never the device callback.
class RecordingSource {
 public:
  using json = nlohmann::json;
  RecordingSource(const json& config, unsigned rate)
      : config_(config), input_(std::filesystem::u8path(config.at("path").get<std::string>())), rate_(rate),
        ratio_(config.value("rate", 1.)), offset_(config.value("offsetMs", 0.) / 1000),
        clock_(config.value("clockRatio", 1.)), pitch_(config.value("pitch", 0.)) {
    if (rate < 8000 || rate > 192000 || !std::isfinite(ratio_) || ratio_ < .25 || ratio_ > 4
        || !std::isfinite(clock_) || clock_ < .95 || clock_ > 1.05 || !std::isfinite(offset_)
        || !std::isfinite(pitch_) || std::abs(pitch_) > 24) throw std::runtime_error("RECORDING_SOURCE_CONFIG");
    const double duration = config.at("durationMs");
    if (!std::isfinite(duration) || duration <= 0 || duration > 86400000.) throw std::runtime_error("RECORDING_DURATION_INVALID");
    frames_ = std::uint64_t(std::ceil(duration * rate / 1000));
    if (config.contains("pluginMapping")) plugin_ = std::make_unique<ipc::Mapping>(std::filesystem::u8path(config.at("pluginMapping").get<std::string>()), false);
    transform_ = std::abs(ratio_ - 1) > 1e-9 || pitch_ != 0;
  }
  std::uint64_t frames() const { return frames_; }
  unsigned rate() const { return rate_; }
  unsigned channels() const { return 2; }
  unsigned read(std::uint64_t position, float* output, unsigned count) {
    const unsigned valid = unsigned(std::min<std::uint64_t>(count, position < frames_ ? frames_ - position : 0));
    std::fill_n(output, count * 2, 0.f);
    if (!valid) return 0;
    if (position != next_) reset(position);
    unsigned copied = 0;
    while (copied < valid) {
      if (cached_ == ipc::quantum) { produce(); cached_ = 0; }
      const auto n = std::min(valid - copied, ipc::quantum - cached_);
      std::copy_n(wet_.data() + cached_ * 2, n * 2, output + copied * 2);
      copied += n; cached_ += n;
    }
    next_ = position + valid; return valid;
  }
 private:
  void input(double first, unsigned count, std::array<std::vector<float>, 2>& out) {
    // Rate conversion of compact capture data; exact copies at equal clocks.
    // A windowed sinc prevents aliases when output and capture rates differ.
    const double step = input_.rate() / double(rate_) * clock_;
    const double start = (first / rate_ - offset_) * input_.rate() * clock_;
    constexpr int radius = 12;
    const auto begin = std::int64_t(std::floor(start)) - radius;
    const auto end = std::int64_t(std::ceil(start + count * step)) + radius + 1;
    const auto from = std::max<std::int64_t>(0, begin), to = std::min<std::int64_t>(input_.frames(), end);
    std::vector<float> raw(std::size_t(std::max<std::int64_t>(0, end - begin)) * input_.channels(), 0.f);
    if (to > from) input_.read(std::uint64_t(from), raw.data() + (from - begin) * input_.channels(), unsigned(to - from));
    for (auto& channel : out) channel.assign(count, 0.f);
    if (std::abs(step - 1) < 1e-9 && std::abs(start - std::round(start)) < 1e-9) {
      for (unsigned f = 0; f < count; ++f) for (unsigned c = 0; c < 2; ++c)
        out[c][f] = raw[(radius + f) * input_.channels() + std::min(c, input_.channels() - 1)];
      return;
    }
    const double cutoff = std::min(1., 1. / step), pi = 3.14159265358979323846;
    for (unsigned f = 0; f < count; ++f) {
      const double at = start + f * step; const auto center = std::int64_t(std::floor(at));
      if (at < -radius || at > double(input_.frames()) + radius) continue;
      double sum = 0; std::array<double, 2> values{};
      for (int d = -radius + 1; d <= radius; ++d) {
        const auto index = center + d; const double distance = at - index;
        const double x = pi * distance * cutoff;
        const double w = (std::abs(x) < 1e-10 ? cutoff : std::sin(x) / (pi * distance)) * (.5 + .5 * std::cos(pi * distance / radius));
        sum += w;
        for (unsigned c = 0; c < 2; ++c) values[c] += raw[(index - begin) * input_.channels() + std::min(c, input_.channels() - 1)] * w;
      }
      if (std::abs(sum) > 1e-9) for (unsigned c = 0; c < 2; ++c) out[c][f] = float(values[c] / sum);
    }
  }
  void reset(std::uint64_t position) {
    effects_.reset();
    if (config_.contains("prepared")) effects_ = std::make_unique<Effects>(config_.at("prepared"), rate_);
    if (plugin_ && (!plugin_->data().ready.load() || plugin_->data().fault.load())) throw std::runtime_error("RECORDING_PLUGIN_UNAVAILABLE");
    const unsigned latency = plugin_ ? plugin_->data().latency.load() : effects_ ? effects_->latency() : 0;
    if (latency > rate_ * 2) throw std::runtime_error("RECORDING_PLUGIN_LATENCY_LIMIT");
    sourceCursor_ = position * ratio_; fraction_ = 0; processed_ = position;
    if (transform_) {
      stretch_ = std::make_unique<signalsmith::stretch::SignalsmithStretch<float>>();
      stretch_->presetDefault(2, rate_); stretch_->setTransposeSemitones(pitch_, 8000. / rate_); stretch_->setFormantSemitones(0, false);
      const unsigned prime = stretch_->outputSeekLength(float(ratio_));
      std::array<std::vector<float>, 2> initial; input(sourceCursor_, prime, initial);
      stretch_->outputSeek(initial, prime); sourceCursor_ += prime;
    }
    cached_ = ipc::quantum; next_ = position;
    // Prime only algorithm latency; never process from the start of a song.
    unsigned remaining = latency;
    while (remaining) { produce(); const auto n = std::min(remaining, ipc::quantum); remaining -= n; cached_ = n; }
  }
  void produce() {
    fraction_ += ipc::quantum * ratio_; const unsigned count = unsigned(std::floor(fraction_ + 1e-9)); fraction_ -= count;
    std::array<std::vector<float>, 2> source, changed;
    input(sourceCursor_, count, source); sourceCursor_ += count;
    if (transform_) { for (auto& c : changed) c.resize(ipc::quantum); stretch_->process(source, count, changed, ipc::quantum); }
    const auto& audio = transform_ ? changed : source;
    std::array<float, ipc::quantum * 2> dry{};
    for (unsigned f = 0; f < ipc::quantum; ++f) for (unsigned c = 0; c < 2; ++c) dry[f * 2 + c] = audio[c][f];
    if (plugin_) {
      auto& shared = plugin_->data(); ipc::Block block;
      block.generation = shared.generation; block.sequence = sequence_++; block.sampleRate = rate_;
      block.samplePosition = processed_; block.continuousPosition = processed_; block.tempo = config_.value("tempo", 120.); block.playing = 1;
      block.projectTimeMusic = (processed_ / double(rate_) - config_.value("beatOffsetMs", 0.) / 1000) * block.tempo / 60;
      block.samples = dry;
      if (!shared.input.push(block)) throw std::runtime_error("RECORDING_PLUGIN_QUEUE_FULL");
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      for (;;) {
        if (const auto* ready = shared.output.front()) {
          const auto result = *ready; shared.output.pop();
          if (result.sequence != block.sequence) continue;
          if (result.error || shared.fault.load()) throw std::runtime_error("RECORDING_PLUGIN_PROCESS_FAILED");
          wet_ = result.samples; break;
        }
        if (shared.shutdown.load() || std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("RECORDING_PLUGIN_PROCESS_TIMEOUT");
        pluginWait_.wait(std::chrono::microseconds(100));
      }
    } else if (effects_) effects_->process(dry.data(), wet_.data(), ipc::quantum, 2);
    else wet_ = dry;
    for (float sample : wet_) if (!std::isfinite(sample)) throw std::runtime_error("RECORDING_NONFINITE_AUDIO");
    processed_ += ipc::quantum;
  }
  json config_; WaveReader input_; unsigned rate_; double ratio_, offset_, clock_, pitch_, sourceCursor_ = 0, fraction_ = 0;
  bool transform_ = false; std::uint64_t frames_ = 0, next_ = UINT64_MAX, processed_ = 0, sequence_ = 0;
  unsigned cached_ = ipc::quantum; std::array<float, ipc::quantum * 2> wet_{};
  std::unique_ptr<Effects> effects_; std::unique_ptr<ipc::Mapping> plugin_;
  std::unique_ptr<signalsmith::stretch::SignalsmithStretch<float>> stretch_;
  WorkerWait pluginWait_;
};

inline int runRecordingStream() {
  try {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::string line; std::getline(std::cin, line); const auto config = nlohmann::json::parse(line);
    RecordingSource source(config, config.at("sampleRate"));
    const auto startFrame = std::uint64_t(std::max(0., config.value("outputStartMs", 0.)) * source.rate() / 1000);
    const auto totalFrames = std::min(source.frames() - std::min(source.frames(), startFrame),
      std::uint64_t(std::ceil(config.value("outputDurationMs", double(source.frames()) / source.rate() * 1000) * source.rate() / 1000)));
    std::ostringstream header(std::ios::binary); writeWaveHeader(header, source.rate(), 2, totalFrames * 8);
    const auto bytes = header.str(); std::uint64_t at = config.value("startByte", std::uint64_t(0));
    const auto end = std::min(config.value("endByte", totalFrames * 8 + 79), totalFrames * 8 + 79);
    if (at < bytes.size()) { const auto n = std::min<std::uint64_t>(bytes.size() - at, end - at + 1); std::cout.write(bytes.data() + at, n); at += n; }
    std::array<float, 4096 * 2> pcm{};
    while (at <= end && std::cout) {
      const auto frame = (at - 80) / 8;
      const auto skip = unsigned((at - 80) % 8);
      const auto frames = unsigned(std::min<std::uint64_t>(4096, (end - at + skip + 8) / 8));
      source.read(startFrame + frame, pcm.data(), frames);
      const auto n = std::min<std::uint64_t>(frames * 8 - skip, end - at + 1);
      std::cout.write(reinterpret_cast<const char*>(pcm.data()) + skip, n); std::cout.flush(); at += n;
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
}
