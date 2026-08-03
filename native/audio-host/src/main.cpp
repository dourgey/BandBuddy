#include <RtAudio.h>
#include <nlohmann/json.hpp>

#ifdef BANDBUDDY_PORTAUDIO_WASAPI
#include <portaudio.h>
#include <pa_win_wasapi.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {
constexpr double kPi = 3.14159265358979323846;
std::mutex outputMutex;

std::int64_t steadyNowNs() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}

void storeMaximum(std::atomic<float>& target, float value) {
  auto current = target.load(std::memory_order_relaxed);
  while (current < value
      && !target.compare_exchange_weak(current, value, std::memory_order_relaxed, std::memory_order_relaxed)) {}
}

void emit(const json& value) {
  std::lock_guard lock(outputMutex);
  std::cout << value.dump() << '\n' << std::flush;
}

void putU16(std::ostream& out, std::uint16_t value) {
  const char bytes[2] = {static_cast<char>(value & 0xff), static_cast<char>((value >> 8) & 0xff)};
  out.write(bytes, 2);
}

void putU32(std::ostream& out, std::uint32_t value) {
  const char bytes[4] = {
    static_cast<char>(value & 0xff), static_cast<char>((value >> 8) & 0xff),
    static_cast<char>((value >> 16) & 0xff), static_cast<char>((value >> 24) & 0xff)
  };
  out.write(bytes, 4);
}

std::uint16_t getU16(const char* bytes) {
  return static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[0])) |
    static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[1]) << 8);
}

std::uint32_t getU32(const char* bytes) {
  return static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[0])) |
    (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[1])) << 8) |
    (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[2])) << 16) |
    (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[3])) << 24);
}

struct WaveData {
  unsigned sampleRate = 0;
  unsigned channels = 0;
  std::vector<float> samples;
};

class FloatRing {
 public:
  explicit FloatRing(std::size_t capacity) : data_(capacity + 1) {}
  bool push(const float* source, std::size_t count) {
    auto write = write_.load(std::memory_order_relaxed);
    const auto read = read_.load(std::memory_order_acquire);
    const auto free = read > write ? read - write - 1 : data_.size() - write + read - 1;
    if (count > free) return false;
    for (std::size_t i = 0; i < count; ++i) { data_[write] = source[i]; write = (write + 1) % data_.size(); }
    write_.store(write, std::memory_order_release);
    return true;
  }
  std::size_t pop(float* target, std::size_t maximum) {
    auto read = read_.load(std::memory_order_relaxed);
    const auto write = write_.load(std::memory_order_acquire);
    const auto available = write >= read ? write - read : data_.size() - read + write;
    const auto count = std::min(maximum, available);
    for (std::size_t i = 0; i < count; ++i) { target[i] = data_[read]; read = (read + 1) % data_.size(); }
    read_.store(read, std::memory_order_release);
    return count;
  }
  bool empty() const { return read_.load(std::memory_order_acquire) == write_.load(std::memory_order_acquire); }
 private:
  std::vector<float> data_;
  std::atomic<std::size_t> read_{0};
  std::atomic<std::size_t> write_{0};
};

class WaveStream {
 public:
  explicit WaveStream(const fs::path& path) {
    stream_.open(path, std::ios::binary);
    if (!stream_) throw std::runtime_error("BACKING_OPEN_FAILED");
    char header[12]{};
    stream_.read(header, sizeof(header));
    if (std::memcmp(header, "RIFF", 4) != 0 || std::memcmp(header + 8, "WAVE", 4) != 0) {
      throw std::runtime_error("BACKING_WAV_INVALID");
    }
    std::uint16_t format = 0;
    std::uint16_t bits = 0;
    std::uint64_t dataBytes = 0;
    std::streampos dataOffset = 0;
    while (stream_) {
      char chunk[8]{};
      stream_.read(chunk, sizeof(chunk));
      if (stream_.gcount() != sizeof(chunk)) break;
      const auto size = getU32(chunk + 4);
      if (std::memcmp(chunk, "fmt ", 4) == 0) {
        std::vector<char> fmt(size);
        stream_.read(fmt.data(), static_cast<std::streamsize>(size));
        if (fmt.size() < 16) throw std::runtime_error("BACKING_WAV_INVALID");
        format = getU16(fmt.data());
        channels_ = getU16(fmt.data() + 2);
        sampleRate_ = getU32(fmt.data() + 4);
        bits = getU16(fmt.data() + 14);
      } else if (std::memcmp(chunk, "data", 4) == 0) {
        dataOffset = stream_.tellg();
        dataBytes = size;
        stream_.seekg(size + (size & 1u), std::ios::cur);
      } else {
        stream_.seekg(size + (size & 1u), std::ios::cur);
      }
    }
    if (format != 3 || bits != 32 || channels_ == 0 || sampleRate_ == 0 || dataBytes == 0 || dataOffset <= 0) {
      throw std::runtime_error("BACKING_WAV_FORMAT_UNSUPPORTED");
    }
    totalSamples_ = dataBytes / sizeof(float);
    totalFrames_ = totalSamples_ / channels_;
    bufferFrames_ = static_cast<std::size_t>(sampleRate_) * 10;
    ring_ = std::make_unique<FloatRing>(bufferFrames_ * channels_);
    stream_.clear();
    stream_.seekg(dataOffset);

    // Prime one second synchronously before opening the realtime stream. The
    // remaining file is read by the bounded producer below.
    const auto primeSamples = std::min<std::uint64_t>(
      totalSamples_,
      static_cast<std::uint64_t>(sampleRate_) * channels_
    );
    std::vector<float> prime(static_cast<std::size_t>(primeSamples));
    stream_.read(
      reinterpret_cast<char*>(prime.data()),
      static_cast<std::streamsize>(prime.size() * sizeof(float))
    );
    const auto primed = static_cast<std::size_t>(stream_.gcount()) / sizeof(float);
    if (primed == 0 || !ring_->push(prime.data(), primed)) throw std::runtime_error("BACKING_STREAM_PRIME_FAILED");
    loadedSamples_ = primed;
    worker_ = std::thread([this] { run(); });
  }

  ~WaveStream() { close(); }
  WaveStream(const WaveStream&) = delete;
  WaveStream& operator=(const WaveStream&) = delete;

  unsigned sampleRate() const { return sampleRate_; }
  unsigned channels() const { return channels_; }
  std::uint64_t totalFrames() const { return totalFrames_; }
  std::size_t bufferFrames() const { return bufferFrames_; }

  std::size_t read(float* target, std::size_t maximum) {
    const auto count = ring_->pop(target, maximum);
    cv_.notify_one();
    return count;
  }

  void close() {
    if (closed_.exchange(true)) return;
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
    stream_.close();
  }

 private:
  void run() {
    std::vector<float> block(16384);
    while (!closed_.load() && loadedSamples_ < totalSamples_) {
      const auto requested = static_cast<std::size_t>(
        std::min<std::uint64_t>(block.size(), totalSamples_ - loadedSamples_)
      );
      stream_.read(
        reinterpret_cast<char*>(block.data()),
        static_cast<std::streamsize>(requested * sizeof(float))
      );
      const auto count = static_cast<std::size_t>(stream_.gcount()) / sizeof(float);
      if (count == 0) break;
      while (!closed_.load() && !ring_->push(block.data(), count)) {
        std::unique_lock lock(waitMutex_);
        cv_.wait_for(lock, std::chrono::milliseconds(4));
      }
      if (!closed_.load()) loadedSamples_ += count;
    }
  }

  std::ifstream stream_;
  std::unique_ptr<FloatRing> ring_;
  std::thread worker_;
  std::condition_variable cv_;
  std::mutex waitMutex_;
  std::atomic<bool> closed_{false};
  unsigned sampleRate_ = 0;
  unsigned channels_ = 0;
  std::uint64_t totalSamples_ = 0;
  std::uint64_t totalFrames_ = 0;
  std::uint64_t loadedSamples_ = 0;
  std::size_t bufferFrames_ = 0;
};

class WaveWriter {
 public:
  WaveWriter(const fs::path& path, unsigned sampleRate, unsigned channels)
    : path_(path), sampleRate_(sampleRate), channels_(channels), ring_(static_cast<std::size_t>(sampleRate) * channels * 10) {
    fs::create_directories(path.parent_path());
    stream_.open(path, std::ios::binary | std::ios::trunc);
    if (!stream_) throw std::runtime_error("CAPTURE_OPEN_FAILED");
    writeHeader(0);
    worker_ = std::thread([this] { run(); });
  }
  ~WaveWriter() { close(); }
  bool write(const float* samples, std::size_t count) {
    if (!ring_.push(samples, count)) return false;
    cv_.notify_one();
    return true;
  }
  void close() {
    if (closed_.exchange(true)) return;
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
    stream_.seekp(0); writeHeader(samplesWritten_ * sizeof(float)); stream_.close();
  }
  std::uint64_t framesWritten() const { return samplesWritten_ / channels_; }
 private:
  void writeHeader(std::uint64_t dataBytes64) {
    const auto dataBytes = static_cast<std::uint32_t>(std::min<std::uint64_t>(dataBytes64, 0xffffffffu - 44));
    stream_.write("RIFF", 4); putU32(stream_, 36 + dataBytes); stream_.write("WAVE", 4);
    stream_.write("fmt ", 4); putU32(stream_, 16); putU16(stream_, 3); putU16(stream_, static_cast<std::uint16_t>(channels_));
    putU32(stream_, sampleRate_); putU32(stream_, sampleRate_ * channels_ * sizeof(float));
    putU16(stream_, static_cast<std::uint16_t>(channels_ * sizeof(float))); putU16(stream_, 32);
    stream_.write("data", 4); putU32(stream_, dataBytes);
  }
  void run() {
    std::vector<float> block(16384);
    while (!closed_.load() || !ring_.empty()) {
      const auto count = ring_.pop(block.data(), block.size());
      if (count) { stream_.write(reinterpret_cast<const char*>(block.data()), static_cast<std::streamsize>(count * sizeof(float))); samplesWritten_ += count; }
      else { std::unique_lock lock(waitMutex_); cv_.wait_for(lock, std::chrono::milliseconds(20)); }
    }
  }
  fs::path path_;
  unsigned sampleRate_;
  unsigned channels_;
  FloatRing ring_;
  std::ofstream stream_;
  std::thread worker_;
  std::condition_variable cv_;
  std::mutex waitMutex_;
  std::atomic<bool> closed_{false};
  std::uint64_t samplesWritten_ = 0;
};

std::string backendName(RtAudio::Api api, bool exclusive = false) {
  switch (api) {
    case RtAudio::WINDOWS_ASIO: return "asio";
    case RtAudio::WINDOWS_WASAPI: return exclusive ? "wasapi-exclusive" : "wasapi-shared";
    case RtAudio::MACOSX_CORE: return "coreaudio";
    default: return "unsupported";
  }
}

RtAudio::Api backendApi(const std::string& backend) {
  if (backend == "asio") return RtAudio::WINDOWS_ASIO;
  if (backend == "wasapi-exclusive" || backend == "wasapi-shared") return RtAudio::WINDOWS_WASAPI;
  if (backend == "coreaudio") return RtAudio::MACOSX_CORE;
#ifdef _WIN32
  return RtAudio::WINDOWS_WASAPI;
#else
  return RtAudio::MACOSX_CORE;
#endif
}

std::optional<unsigned> parseDeviceId(const std::string& value) {
  const auto pos = value.rfind(':');
  if (pos == std::string::npos || pos + 1 >= value.size()) return std::nullopt;
  try { return static_cast<unsigned>(std::stoul(value.substr(pos + 1))); } catch (...) { return std::nullopt; }
}

struct Session {
  std::unique_ptr<RtAudio> audio;
  std::unique_ptr<RtAudio> inputAudio;
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
  PaStream* paAudio = nullptr;
  PaStream* paInputAudio = nullptr;
  bool portAudio = false;
  unsigned inputFirstChannel = 0;
  unsigned deviceInputChannels = 0;
  std::vector<float> mappedInput;
#endif
  WaveData backing;
  std::unique_ptr<WaveStream> backingStream;
  std::vector<float> backingScratch;
  std::unique_ptr<WaveWriter> writer;
  unsigned sampleRate = 0;
  unsigned bufferFrames = 0;
  unsigned inputBufferFrames = 0;
  unsigned inputChannels = 0;
  unsigned outputChannels = 2;
  double playbackRate = 1;
  double startPositionMs = 0;
  double endPositionMs = 0;
  double bpm = 120;
  double beatOffsetMs = 0;
  unsigned countInBeats = 0;
  bool metronome = false;
  bool monitor = false;
  float monitorGain = 0;
  bool testing = false;
  bool splitDevices = false;
  std::atomic<std::uint64_t> callbackFrames{0};
  std::atomic<std::uint64_t> transportFrames{0};
  std::atomic<std::uint64_t> inputFrames{0};
  std::atomic<std::uint64_t> inputStartTransportFrames{std::numeric_limits<std::uint64_t>::max()};
  std::atomic<std::int64_t> outputTransportStartNs{0};
  std::atomic<std::int64_t> inputCaptureStartNs{0};
  std::atomic<std::int64_t> outputTransportEndNs{0};
  std::atomic<unsigned> xruns{0};
  std::atomic<bool> recording{false};
  std::atomic<bool> paused{false};
  std::atomic<bool> finished{false};
  std::atomic<bool> stopRequested{false};
  std::atomic<int> errorType{RTAUDIO_NO_ERROR};
  std::atomic<bool> writeOverflow{false};
  std::atomic<bool> backingUnderflow{false};
  std::thread simulator;
  unsigned simulateXrunEveryCallbacks = 0;
  double simulateInputClockPpm = 0;
  double simulateTimeScale = 1;
  std::array<std::atomic<float>, 2> peak{{0.0f, 0.0f}};
  std::array<std::atomic<float>, 2> rms{{0.0f, 0.0f}};
  std::atomic<bool> clipped{false};
  ~Session() {
    stopRequested.store(true);
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (paAudio) {
      if (Pa_IsStreamActive(paAudio) > 0) Pa_AbortStream(paAudio);
      Pa_CloseStream(paAudio);
      paAudio = nullptr;
    }
    if (paInputAudio) {
      if (Pa_IsStreamActive(paInputAudio) > 0) Pa_AbortStream(paInputAudio);
      Pa_CloseStream(paInputAudio);
      paInputAudio = nullptr;
    }
#endif
    try { if (audio && audio->isStreamRunning()) audio->abortStream(); } catch (...) {}
    try { if (inputAudio && inputAudio->isStreamRunning()) inputAudio->abortStream(); } catch (...) {}
    if (simulator.joinable()) simulator.join();
    if (writer) writer->close();
  }
  std::uint64_t countInFrames() const {
    return countInBeats > 0 ? static_cast<std::uint64_t>(std::llround(countInBeats * 60.0 / bpm / playbackRate * sampleRate)) : 0;
  }
};

int audioCallback(void* outputBuffer, void* inputBuffer, unsigned nFrames, double, RtAudioStreamStatus status, void* userData) {
  auto& s = *static_cast<Session*>(userData);
  auto* output = static_cast<float*>(outputBuffer);
  auto* input = static_cast<float*>(inputBuffer);
  if (output) std::fill(output, output + static_cast<std::size_t>(nFrames) * s.outputChannels, 0.0f);
  if (status) s.xruns.fetch_add(1, std::memory_order_relaxed);
  if (s.testing) {
    if (input) {
      for (unsigned ch = 0; ch < std::min(2u, s.inputChannels); ++ch) {
        double squares = 0; float peak = 0;
        for (unsigned i = 0; i < nFrames; ++i) { const float v = input[i * s.inputChannels + ch]; peak = std::max(peak, std::abs(v)); squares += v * v; }
        storeMaximum(s.peak[ch], peak); s.rms[ch].store(static_cast<float>(std::sqrt(squares / std::max(1u, nFrames))));
        if (peak >= 0.999f) s.clipped.store(true);
      }
    }
    return 0;
  }

  // Meter the input throughout count-in and recording. Capture remains gated
  // below, so the count-in never becomes part of the raw take.
  if (input) {
    for (unsigned ch = 0; ch < std::min(2u, s.inputChannels); ++ch) {
      double squares = 0; float peak = 0;
      for (unsigned i = 0; i < nFrames; ++i) {
        const float value = input[i * s.inputChannels + ch];
        peak = std::max(peak, std::abs(value)); squares += value * value;
      }
      storeMaximum(s.peak[ch], peak);
      s.rms[ch].store(static_cast<float>(std::sqrt(squares / std::max(1u, nFrames))));
      if (peak >= 0.999f) s.clipped.store(true);
    }
  }
  if (s.paused.load()) return 0;

  const auto initial = s.callbackFrames.fetch_add(nFrames, std::memory_order_relaxed);
  const auto countIn = s.countInFrames();
  const auto transportStartInBuffer = initial < countIn ? std::min<std::uint64_t>(nFrames, countIn - initial) : 0;
  const auto backingFrameCount = s.backingStream
    ? s.backingStream->totalFrames()
    : s.backing.channels ? s.backing.samples.size() / s.backing.channels : 0;
  const auto backingChannels = s.backingStream ? s.backingStream->channels() : s.backing.channels;
  std::size_t streamedSamples = 0;
  if (s.backingStream && transportStartInBuffer < nFrames) {
    const auto transportFrame = initial >= countIn ? initial - countIn : 0;
    const auto requestedFrames = static_cast<std::size_t>(std::min<std::uint64_t>(
      nFrames - transportStartInBuffer,
      transportFrame < backingFrameCount ? backingFrameCount - transportFrame : 0
    ));
    const auto requestedSamples = requestedFrames * backingChannels;
    if (requestedSamples > s.backingScratch.size()) {
      s.backingUnderflow.store(true);
      return 2;
    }
    streamedSamples = s.backingStream->read(s.backingScratch.data(), requestedSamples);
    if (streamedSamples != requestedSamples) {
      s.backingUnderflow.store(true);
      return 2;
    }
  }

  for (unsigned i = 0; i < nFrames; ++i) {
    const auto absolute = initial + i;
    if (output && input && s.monitor && !s.splitDevices) {
      for (unsigned ch = 0; ch < 2; ++ch) output[i * 2 + ch] += input[i * s.inputChannels + std::min(ch, s.inputChannels - 1)] * s.monitorGain;
    }
    if (absolute < countIn) {
      if (output && s.countInBeats > 0) {
        const auto beatFrames = static_cast<std::uint64_t>(std::llround(60.0 / s.bpm / s.playbackRate * s.sampleRate));
        const auto beatPhase = beatFrames ? absolute % beatFrames : 0;
        if (beatPhase < s.sampleRate / 80) {
          const auto beat = beatFrames ? absolute / beatFrames : 0;
          const float click = static_cast<float>(std::sin(2 * kPi * (beat % 4 == 0 ? 1560.0 : 1080.0) * beatPhase / s.sampleRate) * (1.0 - beatPhase / static_cast<double>(s.sampleRate / 80)) * 0.22);
          output[i * 2] += click; output[i * 2 + 1] += click;
        }
      }
      continue;
    }
    const auto transportFrame = absolute - countIn;
    if (output && transportFrame < backingFrameCount) {
      if (s.backingStream) {
        const auto streamFrame = static_cast<std::size_t>(i - transportStartInBuffer);
        if ((streamFrame + 1) * backingChannels <= streamedSamples) {
          for (unsigned ch = 0; ch < 2; ++ch) {
            output[i * 2 + ch] = s.backingScratch[
              streamFrame * backingChannels + std::min(ch, backingChannels - 1)
            ];
          }
        }
      } else {
        for (unsigned ch = 0; ch < 2; ++ch) {
          output[i * 2 + ch] = s.backing.samples[
            transportFrame * s.backing.channels + std::min(ch, s.backing.channels - 1)
          ];
        }
      }
    }
    if (output && s.metronome) {
      const double sourceMs = s.startPositionMs + transportFrame * 1000.0 / s.sampleRate * s.playbackRate;
      const double beatMs = 60000.0 / s.bpm;
      double phase = std::fmod(sourceMs - s.beatOffsetMs, beatMs); if (phase < 0) phase += beatMs;
      const auto clickFrames = s.sampleRate / 80;
      const auto phaseFrames = static_cast<unsigned>(phase / 1000.0 / s.playbackRate * s.sampleRate);
      if (phaseFrames < clickFrames) {
        const auto beat = static_cast<long long>(std::floor((sourceMs - s.beatOffsetMs) / beatMs));
        const float click = static_cast<float>(std::sin(2 * kPi * (beat % 4 == 0 ? 1560.0 : 1080.0) * phaseFrames / s.sampleRate) * (1.0 - phaseFrames / static_cast<double>(clickFrames)) * 0.18);
        output[i * 2] += click; output[i * 2 + 1] += click;
      }
    }
  }

  if (output) {
    for (std::size_t sample = 0; sample < static_cast<std::size_t>(nFrames) * s.outputChannels; ++sample) {
      output[sample] = std::clamp(output[sample], -0.98f, 0.98f);
    }
  }

  if (initial + nFrames > countIn) {
    const auto activeFrames = nFrames - static_cast<unsigned>(transportStartInBuffer);
    auto unsetTimestamp = std::int64_t{0};
    const auto transportStartNs = steadyNowNs() + static_cast<std::int64_t>(
      transportStartInBuffer * 1'000'000'000ull / std::max(1u, s.sampleRate));
    s.outputTransportStartNs.compare_exchange_strong(unsetTimestamp, transportStartNs);
    s.transportFrames.fetch_add(activeFrames);
    s.recording.store(true);
  }

  if (input && initial + nFrames > countIn) {
    const unsigned skip = static_cast<unsigned>(transportStartInBuffer);
    auto unsetTimestamp = std::int64_t{0};
    const auto captureStartNs = steadyNowNs() + static_cast<std::int64_t>(
      skip * 1'000'000'000ull / std::max(1u, s.sampleRate));
    s.inputCaptureStartNs.compare_exchange_strong(unsetTimestamp, captureStartNs);
    const auto* capture = input + static_cast<std::size_t>(skip) * s.inputChannels;
    const unsigned captureFrames = nFrames - skip;
    if (s.writer && !s.writer->write(capture, static_cast<std::size_t>(captureFrames) * s.inputChannels)) {
      s.xruns.fetch_add(1);
      s.writeOverflow.store(true);
    }
    s.inputFrames.fetch_add(captureFrames);
  }

  const auto backingFrames = backingFrameCount;
  const auto postRoll = static_cast<std::uint64_t>(s.sampleRate / 4);
  if (s.writeOverflow.load()) return 2;
  if (initial + nFrames >= countIn + backingFrames + postRoll) {
    s.outputTransportEndNs.store(steadyNowNs());
    s.finished.store(true);
    return 1;
  }
  return 0;
}

int splitInputCallback(void*, void* inputBuffer, unsigned nFrames, double, RtAudioStreamStatus status, void* userData) {
  auto& s = *static_cast<Session*>(userData);
  auto* input = static_cast<float*>(inputBuffer);
  if (status) s.xruns.fetch_add(1, std::memory_order_relaxed);
  if (s.finished.load()) return 1;
  if (!input || (!s.testing && !s.recording.load())) return 0;
  if (!s.testing && !s.paused.load()) {
    auto unset = std::numeric_limits<std::uint64_t>::max();
    s.inputStartTransportFrames.compare_exchange_strong(unset, s.transportFrames.load());
    auto unsetTimestamp = std::int64_t{0};
    s.inputCaptureStartNs.compare_exchange_strong(unsetTimestamp, steadyNowNs());
    if (s.writer && !s.writer->write(input, static_cast<std::size_t>(nFrames) * s.inputChannels)) {
      s.xruns.fetch_add(1);
      s.writeOverflow.store(true);
    }
    s.inputFrames.fetch_add(nFrames);
  }
  for (unsigned ch = 0; ch < std::min(2u, s.inputChannels); ++ch) {
    double squares = 0; float peak = 0;
    for (unsigned frame = 0; frame < nFrames; ++frame) {
      const float value = input[static_cast<std::size_t>(frame) * s.inputChannels + ch];
      peak = std::max(peak, std::abs(value)); squares += value * value;
    }
    storeMaximum(s.peak[ch], peak);
    s.rms[ch].store(static_cast<float>(std::sqrt(squares / std::max(1u, nFrames))));
    if (peak >= 0.999f) s.clipped.store(true);
  }
  return s.writeOverflow.load() ? 2 : 0;
}

#ifdef BANDBUDDY_PORTAUDIO_WASAPI
RtAudioStreamStatus portAudioStatus(PaStreamCallbackFlags flags) {
  RtAudioStreamStatus status = 0;
  if (flags & (paInputUnderflow | paInputOverflow)) status |= RTAUDIO_INPUT_OVERFLOW;
  if (flags & (paOutputUnderflow | paOutputOverflow)) status |= RTAUDIO_OUTPUT_UNDERFLOW;
  return status;
}

const float* selectPortAudioInput(Session& session, const void* input, unsigned long frames) {
  if (!input) return nullptr;
  const auto* samples = static_cast<const float*>(input);
  if (session.inputFirstChannel == 0 && session.deviceInputChannels == session.inputChannels) return samples;
  const auto required = static_cast<std::size_t>(frames) * session.inputChannels;
  if (required > session.mappedInput.size()) {
    session.writeOverflow.store(true);
    return nullptr;
  }
  for (unsigned long frame = 0; frame < frames; ++frame) {
    for (unsigned channel = 0; channel < session.inputChannels; ++channel) {
      session.mappedInput[static_cast<std::size_t>(frame) * session.inputChannels + channel] =
        samples[static_cast<std::size_t>(frame) * session.deviceInputChannels + session.inputFirstChannel + channel];
    }
  }
  return session.mappedInput.data();
}

int toPortAudioResult(int result) {
  return result == 0 ? paContinue : result == 1 ? paComplete : paAbort;
}

int portAudioOutputCallback(const void*, void* output, unsigned long frames, const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags flags, void* userData) {
  if (frames > std::numeric_limits<unsigned>::max()) return paAbort;
  return toPortAudioResult(audioCallback(output, nullptr, static_cast<unsigned>(frames), 0, portAudioStatus(flags), userData));
}

int portAudioInputCallback(const void* input, void*, unsigned long frames, const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags flags, void* userData) {
  if (frames > std::numeric_limits<unsigned>::max()) return paAbort;
  auto& session = *static_cast<Session*>(userData);
  const auto* selected = selectPortAudioInput(session, input, frames);
  if (session.writeOverflow.load()) return paAbort;
  return toPortAudioResult(splitInputCallback(nullptr, const_cast<float*>(selected), static_cast<unsigned>(frames), 0, portAudioStatus(flags), userData));
}

int portAudioDuplexCallback(const void* input, void* output, unsigned long frames, const PaStreamCallbackTimeInfo*, PaStreamCallbackFlags flags, void* userData) {
  if (frames > std::numeric_limits<unsigned>::max()) return paAbort;
  auto& session = *static_cast<Session*>(userData);
  const auto* selected = selectPortAudioInput(session, input, frames);
  if (session.writeOverflow.load()) return paAbort;
  return toPortAudioResult(audioCallback(output, const_cast<float*>(selected), static_cast<unsigned>(frames), 0, portAudioStatus(flags), userData));
}

void portAudioStateCallback(PaStream*, unsigned int stateFlags, unsigned int, void* userData) {
  if (stateFlags & paWasapiStreamStateError) {
    static_cast<Session*>(userData)->errorType.store(RTAUDIO_DEVICE_DISCONNECT);
  }
}

PaWasapiStreamInfo wasapiStreamInfo(bool exclusive) {
  PaWasapiStreamInfo info{};
  info.size = sizeof(info);
  info.hostApiType = paWASAPI;
  info.version = 1;
  info.flags = (exclusive ? paWinWasapiExclusive : paWinWasapiAutoConvert) | paWinWasapiThreadPriority;
  info.threadPriority = exclusive ? eThreadPriorityProAudio : eThreadPriorityAudio;
  info.streamCategory = eAudioCategoryMedia;
  info.streamOption = eStreamOptionNone;
  return info;
}

std::string portAudioError(const char* operation, PaError error) {
  return std::string(operation) + ":" + (Pa_GetErrorText(error) ? Pa_GetErrorText(error) : "unknown");
}
#endif

class Host {
 public:
  explicit Host(bool simulate = false) : simulate_(simulate) {
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (!simulate_) {
      const auto error = Pa_Initialize();
      if (error != paNoError) throw std::runtime_error(portAudioError("PORTAUDIO_INITIALIZE_FAILED", error));
      portAudioInitialized_ = true;
    }
#endif
    eventThread_ = std::thread([this] { eventLoop(); });
  }
  ~Host() {
    shuttingDown_.store(true);
    stopSession(false);
    if (eventThread_.joinable()) eventThread_.join();
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (portAudioInitialized_) Pa_Terminate();
#endif
  }

  json devices() {
    json devices = json::array();
    if (simulate_) {
#ifdef _WIN32
      const std::string backend = "wasapi-shared";
#else
      const std::string backend = "coreaudio";
#endif
      devices.push_back({
        {"id", backend + ":0"}, {"backend", backend}, {"name", "BandBuddy simulated duplex device"},
        {"inputChannels", 2}, {"outputChannels", 2}, {"duplexChannels", 2},
        {"sampleRates", {44100, 48000, 96000}}, {"preferredSampleRate", 48000},
        {"defaultInput", true}, {"defaultOutput", true}
      });
      devices.push_back({
        {"id", backend + ":1"}, {"backend", backend}, {"name", "BandBuddy simulated secondary input"},
        {"inputChannels", 2}, {"outputChannels", 0}, {"duplexChannels", 0},
        {"sampleRates", {44100, 48000, 96000}}, {"preferredSampleRate", 48000},
        {"defaultInput", false}, {"defaultOutput", false}
      });
      return devices;
    }
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (portAudioInitialized_) {
      bool canRefresh = false;
      { std::lock_guard lock(sessionMutex_); canRefresh = !session_; }
      if (canRefresh) PaWasapi_UpdateDeviceList();
      const auto hostApi = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
      const auto* hostInfo = hostApi >= 0 ? Pa_GetHostApiInfo(hostApi) : nullptr;
      const auto count = Pa_GetDeviceCount();
      constexpr std::array<unsigned, 14> standardRates{
        4000, 5512, 8000, 9600, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000
      };
      for (PaDeviceIndex index = 0; index < count; ++index) {
        const auto* info = Pa_GetDeviceInfo(index);
        if (!info || info->hostApi != hostApi || (info->maxInputChannels <= 0 && info->maxOutputChannels <= 0)) continue;
        for (const bool exclusive : {false, true}) {
          auto streamInfo = wasapiStreamInfo(exclusive);
          PaStreamParameters input{};
          input.device = index;
          input.channelCount = std::min(2, info->maxInputChannels);
          input.sampleFormat = paFloat32;
          input.suggestedLatency = info->defaultLowInputLatency;
          input.hostApiSpecificStreamInfo = &streamInfo;
          PaStreamParameters output{};
          output.device = index;
          output.channelCount = std::min(2, info->maxOutputChannels);
          output.sampleFormat = paFloat32;
          output.suggestedLatency = info->defaultLowOutputLatency;
          output.hostApiSpecificStreamInfo = &streamInfo;
          std::vector<unsigned> rates;
          for (const auto rate : standardRates) {
            const auto supported = Pa_IsFormatSupported(
              info->maxInputChannels > 0 ? &input : nullptr,
              info->maxOutputChannels > 0 ? &output : nullptr,
              rate);
            if (supported == paFormatIsSupported) rates.push_back(rate);
          }
          if (rates.empty()) continue;
          const auto backend = exclusive ? "wasapi-exclusive" : "wasapi-shared";
          devices.push_back({
            {"id", backend + std::string(":") + std::to_string(index)}, {"backend", backend}, {"name", info->name ? info->name : "WASAPI device"},
            {"inputChannels", info->maxInputChannels}, {"outputChannels", info->maxOutputChannels},
            {"duplexChannels", std::min(info->maxInputChannels, info->maxOutputChannels)}, {"sampleRates", rates},
            {"preferredSampleRate", static_cast<unsigned>(std::llround(info->defaultSampleRate))},
            {"defaultInput", hostInfo && hostInfo->defaultInputDevice == index},
            {"defaultOutput", hostInfo && hostInfo->defaultOutputDevice == index}
          });
        }
      }
    }
#endif
    std::vector<RtAudio::Api> apis;
    RtAudio::getCompiledApi(apis);
    for (auto api : apis) {
      if (api != RtAudio::WINDOWS_ASIO && api != RtAudio::WINDOWS_WASAPI && api != RtAudio::MACOSX_CORE) continue;
      try {
        RtAudio audio(api);
        for (const auto id : audio.getDeviceIds()) {
          const auto info = audio.getDeviceInfo(id);
          const std::array<bool, 2> variants = api == RtAudio::WINDOWS_WASAPI ? std::array<bool, 2>{false, true} : std::array<bool, 2>{false, false};
          for (std::size_t variant = 0; variant < (api == RtAudio::WINDOWS_WASAPI ? 2u : 1u); ++variant) {
            const auto backend = backendName(api, variants[variant]);
            devices.push_back({
              {"id", backend + ":" + std::to_string(id)}, {"backend", backend}, {"name", info.name},
              {"inputChannels", info.inputChannels}, {"outputChannels", info.outputChannels}, {"duplexChannels", info.duplexChannels},
              {"sampleRates", info.sampleRates}, {"preferredSampleRate", info.preferredSampleRate ? info.preferredSampleRate : info.currentSampleRate},
              {"defaultInput", info.isDefaultInput}, {"defaultOutput", info.isDefaultOutput}
            });
          }
        }
      } catch (...) {}
    }
    return devices;
  }

  json start(const json& params, bool testing) {
    stopSession(false);
    auto session = std::make_unique<Session>();
    const auto backend = params.value("backend", "auto");
    const auto api = backendApi(backend);
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    const bool usePortAudio = !simulate_ && (backend == "wasapi-shared" || backend == "wasapi-exclusive");
    session->portAudio = usePortAudio;
#else
    const bool usePortAudio = false;
#endif
    if (!simulate_ && !usePortAudio) {
      Session* target = session.get();
      session->audio = std::make_unique<RtAudio>(api, [target](RtAudioErrorType type, const std::string&) {
        if (type != RTAUDIO_NO_ERROR && type != RTAUDIO_WARNING) target->errorType.store(static_cast<int>(type));
      });
    }
    const auto parsedInputId = parseDeviceId(params.value("inputDeviceId", ""));
    const auto parsedOutputId = parseDeviceId(params.value("outputDeviceId", ""));
    unsigned inputId = 0;
    unsigned outputId = 0;
    if (simulate_) {
      inputId = parsedInputId.value_or(0u);
      outputId = parsedOutputId.value_or(0u);
    } else if (usePortAudio) {
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
      const auto hostApi = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
      const auto* hostInfo = hostApi >= 0 ? Pa_GetHostApiInfo(hostApi) : nullptr;
      if (!hostInfo) throw std::runtime_error("WASAPI_HOST_API_MISSING");
      if (!parsedInputId && hostInfo->defaultInputDevice == paNoDevice) throw std::runtime_error("NO_AUDIO_INPUT_DEVICE");
      if (!parsedOutputId && hostInfo->defaultOutputDevice == paNoDevice) throw std::runtime_error("NO_AUDIO_OUTPUT_DEVICE");
      inputId = parsedInputId.value_or(static_cast<unsigned>(hostInfo->defaultInputDevice));
      outputId = parsedOutputId.value_or(static_cast<unsigned>(hostInfo->defaultOutputDevice));
#endif
    } else {
      inputId = parsedInputId.value_or(session->audio->getDefaultInputDevice());
      outputId = parsedOutputId.value_or(session->audio->getDefaultOutputDevice());
    }
    const auto inputChannels = params.value("inputChannels", std::vector<unsigned>{0});
    if (inputChannels.empty() || inputChannels.size() > 2) throw std::runtime_error("INPUT_CHANNELS_INVALID");
    session->inputChannels = static_cast<unsigned>(inputChannels.size());
    session->splitDevices = inputId != outputId;
    if (!simulate_ && !usePortAudio && session->splitDevices) {
      Session* target = session.get();
      session->inputAudio = std::make_unique<RtAudio>(api, [target](RtAudioErrorType type, const std::string&) {
        if (type != RTAUDIO_NO_ERROR && type != RTAUDIO_WARNING) target->errorType.store(static_cast<int>(type));
      });
    }
    session->testing = testing;
    session->sampleRate = params.value("sampleRate", 0u);
    if (!session->sampleRate) {
      if (simulate_) session->sampleRate = 48000;
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
      else if (usePortAudio) {
        const auto* outputInfo = Pa_GetDeviceInfo(static_cast<PaDeviceIndex>(outputId));
        if (!outputInfo) throw std::runtime_error("SELECTED_OUTPUT_DEVICE_MISSING");
        session->sampleRate = static_cast<unsigned>(std::llround(outputInfo->defaultSampleRate));
      }
#endif
      else {
        const auto outputInfo = session->audio->getDeviceInfo(outputId);
        session->sampleRate = outputInfo.preferredSampleRate ? outputInfo.preferredSampleRate : 48000;
      }
    }
    session->bufferFrames = params.value("bufferFrames", 0u);
    if (simulate_ && !session->bufferFrames) session->bufferFrames = 256;
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (usePortAudio) {
      session->inputFirstChannel = inputChannels.front();
      session->deviceInputChannels = inputChannels.front() + session->inputChannels;
      session->mappedInput.resize(static_cast<std::size_t>(std::max(16384u, session->bufferFrames)) * session->inputChannels);
    }
#endif
    session->monitor = params.value("softwareMonitoring", false) && !session->splitDevices;
    session->monitorGain = std::pow(10.0f, params.value("monitorGainDb", -6.0f) / 20.0f);
    session->playbackRate = params.value("playbackRate", 1.0);
    session->startPositionMs = params.value("startPositionMs", 0.0);
    session->endPositionMs = params.value("endPositionMs", session->startPositionMs);
    session->bpm = params.value("metronomeBpm", 120.0);
    session->beatOffsetMs = params.value("metronomeOffsetMs", 0.0);
    session->metronome = params.value("metronomeEnabled", false);
    session->countInBeats = params.value("countInBeats", 0u);
    session->simulateXrunEveryCallbacks = params.value("simulateXrunEveryCallbacks", 0u);
    session->simulateInputClockPpm = params.value("simulateInputClockPpm", 0.0);
    session->simulateTimeScale = std::clamp(params.value("simulateTimeScale", 1.0), 0.01, 10.0);
    if (!testing) {
      session->backingStream = std::make_unique<WaveStream>(params.at("backingPath").get<std::string>());
      if (session->backingStream->sampleRate() != session->sampleRate) throw std::runtime_error("BACKING_SAMPLE_RATE_MISMATCH");
      session->backingScratch.resize(
        static_cast<std::size_t>(262144) * session->backingStream->channels()
      );
      session->writer = std::make_unique<WaveWriter>(params.at("capturePath").get<std::string>(), session->sampleRate, session->inputChannels);
    }
    if (simulate_) {
      const auto result = json{{"sampleRate", session->sampleRate}, {"bufferFrames", session->bufferFrames},
        {"latencyMs", session->bufferFrames * 2000.0 / session->sampleRate}, {"splitDevices", session->splitDevices},
        {"streamingBacking", !testing}, {"backingBufferFrames", testing ? 0 : session->backingStream->bufferFrames()}};
      Session* running = session.get();
      if (running->splitDevices) {
        running->simulator = std::thread([running] {
          std::vector<float> input(static_cast<std::size_t>(running->bufferFrames) * running->inputChannels);
          std::vector<float> output(static_cast<std::size_t>(running->bufferFrames) * 2);
          std::uint64_t generatedFrames = 0;
          std::uint64_t callback = 0;
          double pendingInputFrames = 0;
          const auto clockScale = 1.0 + running->simulateInputClockPpm / 1'000'000.0;
          while (!running->stopRequested.load() && !running->finished.load()) {
            if (audioCallback(output.data(), nullptr, running->bufferFrames, 0, 0, running) != 0) break;
            pendingInputFrames += running->bufferFrames * clockScale;
            while (pendingInputFrames >= running->bufferFrames && !running->finished.load()) {
              for (unsigned frame = 0; frame < running->bufferFrames; ++frame) {
                for (unsigned channel = 0; channel < running->inputChannels; ++channel) {
                  const double frequency = channel == 0 ? 440.0 : 660.0;
                  const float amplitude = channel == 0 ? 0.25f : 0.125f;
                  input[static_cast<std::size_t>(frame) * running->inputChannels + channel] =
                    amplitude * static_cast<float>(std::sin(2 * kPi * frequency * (generatedFrames + frame) / running->sampleRate));
                }
              }
              generatedFrames += running->bufferFrames;
              pendingInputFrames -= running->bufferFrames;
              const auto status = running->simulateXrunEveryCallbacks && ++callback % running->simulateXrunEveryCallbacks == 0
                ? static_cast<RtAudioStreamStatus>(RTAUDIO_INPUT_OVERFLOW) : 0u;
              if (splitInputCallback(nullptr, input.data(), running->bufferFrames, 0, status, running) != 0) break;
            }
            const auto blockDuration = std::chrono::duration<double>(running->bufferFrames / static_cast<double>(running->sampleRate) * running->simulateTimeScale);
            if (blockDuration >= std::chrono::milliseconds(1)) std::this_thread::sleep_for(blockDuration);
            else std::this_thread::yield();
          }
        });
      } else {
        running->simulator = std::thread([running] {
          std::vector<float> input(static_cast<std::size_t>(running->bufferFrames) * running->inputChannels);
          std::vector<float> output(static_cast<std::size_t>(running->bufferFrames) * 2);
          std::uint64_t callback = 0;
          while (!running->stopRequested.load() && !running->finished.load()) {
            const auto initial = running->callbackFrames.load();
            for (unsigned frame = 0; frame < running->bufferFrames; ++frame) {
              for (unsigned channel = 0; channel < running->inputChannels; ++channel) {
                const double frequency = channel == 0 ? 440.0 : 660.0;
                const float amplitude = channel == 0 ? 0.25f : 0.125f;
                input[static_cast<std::size_t>(frame) * running->inputChannels + channel] =
                  amplitude * static_cast<float>(std::sin(2 * kPi * frequency * (initial + frame) / running->sampleRate));
              }
            }
            const auto status = running->simulateXrunEveryCallbacks && ++callback % running->simulateXrunEveryCallbacks == 0
              ? static_cast<RtAudioStreamStatus>(RTAUDIO_INPUT_OVERFLOW) : 0u;
            if (audioCallback(output.data(), input.data(), running->bufferFrames, 0, status, running) != 0) break;
            const auto blockDuration = std::chrono::duration<double>(running->bufferFrames / static_cast<double>(running->sampleRate) * running->simulateTimeScale);
            if (blockDuration >= std::chrono::milliseconds(1)) std::this_thread::sleep_for(blockDuration);
            else std::this_thread::yield();
          }
        });
      }
      // Publish only after the simulator thread object is fully constructed;
      // the event thread may otherwise race with stopSession().
      { std::lock_guard lock(sessionMutex_); session_ = std::move(session); }
      return result;
    }
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (usePortAudio) {
      const auto* inputDevice = Pa_GetDeviceInfo(static_cast<PaDeviceIndex>(inputId));
      const auto* outputDevice = Pa_GetDeviceInfo(static_cast<PaDeviceIndex>(outputId));
      const auto hostApi = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
      if (!inputDevice || inputDevice->hostApi != hostApi) throw std::runtime_error("SELECTED_INPUT_DEVICE_MISSING");
      if (!outputDevice || outputDevice->hostApi != hostApi) throw std::runtime_error("SELECTED_OUTPUT_DEVICE_MISSING");
      if (session->deviceInputChannels > static_cast<unsigned>(inputDevice->maxInputChannels)) throw std::runtime_error("INPUT_CHANNEL_UNAVAILABLE");
      if (outputDevice->maxOutputChannels < 2) throw std::runtime_error("OUTPUT_STEREO_UNAVAILABLE");

      const bool exclusive = backend == "wasapi-exclusive";
      auto inputWasapi = wasapiStreamInfo(exclusive);
      auto outputWasapi = wasapiStreamInfo(exclusive);
      const auto requestedFrames = session->bufferFrames;
      const auto requestedLatency = requestedFrames / static_cast<double>(session->sampleRate);
      PaStreamParameters input{};
      input.device = static_cast<PaDeviceIndex>(inputId);
      input.channelCount = static_cast<int>(session->deviceInputChannels);
      input.sampleFormat = paFloat32;
      input.suggestedLatency = requestedFrames ? requestedLatency : inputDevice->defaultLowInputLatency;
      input.hostApiSpecificStreamInfo = &inputWasapi;
      PaStreamParameters output{};
      output.device = static_cast<PaDeviceIndex>(outputId);
      output.channelCount = 2;
      output.sampleFormat = paFloat32;
      output.suggestedLatency = requestedFrames ? requestedLatency : outputDevice->defaultLowOutputLatency;
      output.hostApiSpecificStreamInfo = &outputWasapi;
      const auto streamFlags = static_cast<PaStreamFlags>(paClipOff | paDitherOff);

      if (session->splitDevices) {
        auto error = Pa_OpenStream(&session->paInputAudio, &input, nullptr, session->sampleRate, requestedFrames,
          streamFlags, portAudioInputCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_INPUT_OPEN_FAILED", error));
        error = PaWasapi_SetStreamStateHandler(session->paInputAudio, portAudioStateCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_INPUT_STATE_HANDLER_FAILED", error));
        error = Pa_OpenStream(&session->paAudio, nullptr, &output, session->sampleRate, requestedFrames,
          streamFlags, portAudioOutputCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_OUTPUT_OPEN_FAILED", error));
        error = PaWasapi_SetStreamStateHandler(session->paAudio, portAudioStateCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_OUTPUT_STATE_HANDLER_FAILED", error));
        error = Pa_StartStream(session->paInputAudio);
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_INPUT_START_FAILED", error));
        error = Pa_StartStream(session->paAudio);
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_OUTPUT_START_FAILED", error));
      } else {
        auto error = Pa_OpenStream(&session->paAudio, &input, &output, session->sampleRate, requestedFrames,
          streamFlags, portAudioDuplexCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_OPEN_FAILED", error));
        error = PaWasapi_SetStreamStateHandler(session->paAudio, portAudioStateCallback, session.get());
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_STATE_HANDLER_FAILED", error));
        error = Pa_StartStream(session->paAudio);
        if (error != paNoError) throw std::runtime_error(portAudioError("AUDIO_START_FAILED", error));
      }

      const auto* outputStream = Pa_GetStreamInfo(session->paAudio);
      const auto* inputStream = session->splitDevices ? Pa_GetStreamInfo(session->paInputAudio) : outputStream;
      if (!outputStream || !inputStream) throw std::runtime_error("AUDIO_STREAM_INFO_MISSING");
      if (std::abs(outputStream->sampleRate - session->sampleRate) > 0.5) throw std::runtime_error("AUDIO_SAMPLE_RATE_CHANGED");
      unsigned actualInputFrames = 0;
      unsigned actualOutputFrames = 0;
      if (session->splitDevices) {
        PaWasapi_GetFramesPerHostBuffer(session->paInputAudio, &actualInputFrames, nullptr);
        PaWasapi_GetFramesPerHostBuffer(session->paAudio, nullptr, &actualOutputFrames);
      } else {
        PaWasapi_GetFramesPerHostBuffer(session->paAudio, &actualInputFrames, &actualOutputFrames);
      }
      session->bufferFrames = std::max(actualInputFrames, actualOutputFrames);
      if (!session->bufferFrames) session->bufferFrames = requestedFrames ? requestedFrames : 256;
      session->inputBufferFrames = session->bufferFrames;
      const auto latencyMs = (inputStream->inputLatency + outputStream->outputLatency) * 1000.0;
      const auto result = json{{"sampleRate", session->sampleRate}, {"bufferFrames", session->bufferFrames},
        {"latencyMs", latencyMs}, {"splitDevices", session->splitDevices},
        {"streamingBacking", true}, {"backingBufferFrames", session->backingStream->bufferFrames()}};
      { std::lock_guard lock(sessionMutex_); session_ = std::move(session); }
      return result;
    }
#endif
    RtAudio::StreamParameters input{inputId, session->inputChannels, inputChannels.front()};
    RtAudio::StreamParameters output{outputId, 2, 0};
    RtAudio::StreamOptions options;
    options.flags = RTAUDIO_MINIMIZE_LATENCY | RTAUDIO_SCHEDULE_REALTIME;
    if (backend == "asio") options.flags |= RTAUDIO_HOG_DEVICE;
    long latency = 0;
    if (session->splitDevices) {
      auto inputBufferFrames = session->bufferFrames;
      const auto inputError = session->inputAudio->openStream(nullptr, &input, RTAUDIO_FLOAT32, session->sampleRate, &inputBufferFrames, splitInputCallback, session.get(), &options);
      if (inputError != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_INPUT_OPEN_FAILED:" + session->inputAudio->getErrorText());
      session->inputBufferFrames = inputBufferFrames;
      auto outputBufferFrames = session->bufferFrames;
      const auto outputError = session->audio->openStream(&output, nullptr, RTAUDIO_FLOAT32, session->sampleRate, &outputBufferFrames, audioCallback, session.get(), &options);
      if (outputError != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_OUTPUT_OPEN_FAILED:" + session->audio->getErrorText());
      session->bufferFrames = outputBufferFrames;
      latency = session->inputAudio->getStreamLatency() + session->audio->getStreamLatency();
      const auto inputStartError = session->inputAudio->startStream();
      if (inputStartError != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_INPUT_START_FAILED:" + session->inputAudio->getErrorText());
      const auto outputStartError = session->audio->startStream();
      if (outputStartError != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_OUTPUT_START_FAILED:" + session->audio->getErrorText());
    } else {
      auto bufferFrames = session->bufferFrames;
      const auto error = session->audio->openStream(&output, &input, RTAUDIO_FLOAT32, session->sampleRate, &bufferFrames, audioCallback, session.get(), &options);
      if (error != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_OPEN_FAILED:" + session->audio->getErrorText());
      session->bufferFrames = bufferFrames;
      session->inputBufferFrames = bufferFrames;
      latency = session->audio->getStreamLatency();
      const auto startError = session->audio->startStream();
      if (startError != RTAUDIO_NO_ERROR) throw std::runtime_error("AUDIO_START_FAILED:" + session->audio->getErrorText());
    }
    const auto actualRate = session->audio->getStreamSampleRate();
    if (actualRate && actualRate != session->sampleRate) throw std::runtime_error("AUDIO_SAMPLE_RATE_CHANGED");
    const auto result = json{{"sampleRate", session->sampleRate}, {"bufferFrames", session->bufferFrames},
      {"latencyMs", latency > 0 ? latency * 1000.0 / session->sampleRate : 0.0}, {"splitDevices", session->splitDevices},
      {"streamingBacking", true}, {"backingBufferFrames", session->backingStream->bufferFrames()}};
    { std::lock_guard lock(sessionMutex_); session_ = std::move(session); }
    return result;
  }

  json stopSession(bool emitFinished) {
    std::unique_ptr<Session> session;
    { std::lock_guard lock(sessionMutex_); session = std::move(session_); }
    if (!session) return nullptr;
    session->stopRequested.store(true);
    if (!session->outputTransportEndNs.load()) session->outputTransportEndNs.store(steadyNowNs());
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
    if (session->portAudio) {
      const auto stopPortAudio = [](PaStream* stream) {
        if (!stream) return;
        const auto active = Pa_IsStreamActive(stream);
        if (active > 0) {
          const auto error = Pa_StopStream(stream);
          if (error != paNoError) Pa_AbortStream(stream);
        } else if (active < 0) Pa_AbortStream(stream);
      };
      stopPortAudio(session->paInputAudio);
      stopPortAudio(session->paAudio);
    }
#endif
    try { if (session->inputAudio && session->inputAudio->isStreamRunning()) session->inputAudio->stopStream(); } catch (...) { try { session->inputAudio->abortStream(); } catch (...) {} }
    try { if (session->audio && session->audio->isStreamRunning()) session->audio->stopStream(); } catch (...) { try { session->audio->abortStream(); } catch (...) {} }
    if (session->simulator.joinable()) session->simulator.join();
    if (session->writer) session->writer->close();
    const auto frames = session->writer ? session->writer->framesWritten() : 0;
    double clockCorrectionRatio = 1.0;
    auto correctionOutputFrames = session->transportFrames.load();
    const auto inputStartOutputFrames = session->inputStartTransportFrames.load() == std::numeric_limits<std::uint64_t>::max()
      ? 0 : session->inputStartTransportFrames.load();
    if (session->splitDevices && session->sampleRate && frames > session->sampleRate * 5ull) {
      const auto inputStart = session->inputStartTransportFrames.load();
      const auto outputEnd = session->transportFrames.load();
      if (inputStart != std::numeric_limits<std::uint64_t>::max() && outputEnd > inputStart) {
        const auto outputFrames = outputEnd - inputStart;
        correctionOutputFrames = outputFrames;
        clockCorrectionRatio = std::clamp(frames / static_cast<double>(outputFrames), 0.98, 1.02);
      }
    }
    const json result{{"frames", frames}, {"sampleRate", session->sampleRate}, {"channels", session->inputChannels}, {"xruns", session->xruns.load()},
      {"durationMs", session->sampleRate ? frames * 1000.0 / session->sampleRate : 0.0},
      {"outputFrames", session->transportFrames.load()}, {"correctionOutputFrames", correctionOutputFrames}, {"clockCorrectionRatio", clockCorrectionRatio},
      {"inputStartOutputFrames", inputStartOutputFrames}, {"outputTransportStartNs", session->outputTransportStartNs.load()},
      {"inputCaptureStartNs", session->inputCaptureStartNs.load()}, {"outputTransportEndNs", session->outputTransportEndNs.load()}};
    if (emitFinished) emit({{"event", "finished"}, {"data", result}});
    return result;
  }

  json pauseSession() {
    std::lock_guard lock(sessionMutex_);
    if (!session_ || session_->testing) return false;
    session_->paused.store(true);
    return true;
  }

  json resumeSession() {
    std::lock_guard lock(sessionMutex_);
    if (!session_ || session_->testing) return false;
    session_->paused.store(false);
    return true;
  }

 private:
  void eventLoop() {
    while (!shuttingDown_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
      json event;
      bool finished = false;
      int errorType = RTAUDIO_NO_ERROR;
      {
        std::lock_guard lock(sessionMutex_);
        if (session_) {
          const auto transport = session_->transportFrames.load();
          const auto sourcePosition = session_->startPositionMs + transport * 1000.0 / session_->sampleRate * session_->playbackRate;
          const auto countInFrames = session_->countInFrames();
          const auto elapsed = session_->callbackFrames.load();
          const auto remainingFrames = elapsed < countInFrames ? countInFrames - elapsed : 0;
          const auto beatFrames = static_cast<std::uint64_t>(std::max(1.0, 60.0 / session_->bpm / session_->playbackRate * session_->sampleRate));
          event = {{"event", "meter"}, {"data", {
            {"peak", {session_->peak[0].exchange(0), session_->peak[1].exchange(0)}},
            {"rms", {session_->rms[0].exchange(0), session_->rms[1].exchange(0)}}, {"clipped", session_->clipped.exchange(false)},
            {"sourcePositionMs", sourcePosition}, {"countInRemaining", remainingFrames ? static_cast<unsigned>((remainingFrames + beatFrames - 1) / beatFrames) : 0},
            {"recording", session_->recording.load()}, {"paused", session_->paused.load()},
            {"captureFrames", session_->inputFrames.load()}, {"xruns", session_->xruns.load()}
          }}};
          finished = session_->finished.load();
          errorType = session_->errorType.load();
          if (session_->writeOverflow.load()) errorType = -1;
          if (session_->backingUnderflow.load()) errorType = -2;
        }
      }
      if (!event.empty()) emit(event);
      if (errorType != RTAUDIO_NO_ERROR) {
        const auto capture = stopSession(false);
        emit({{"event", "error"}, {"data", {{"error",
          errorType == -1 ? "CAPTURE_WRITE_OVERFLOW"
          : errorType == -2 ? "BACKING_STREAM_UNDERRUN"
          : errorType == RTAUDIO_DEVICE_DISCONNECT ? "DEVICE_DISCONNECTED"
          : "AUDIO_DRIVER_ERROR"
        }, {"capture", capture}}}});
        continue;
      }
      // stopSession atomically removes the active session, so this cannot emit
      // twice. Avoid carrying a finished flag across two very short sessions.
      if (finished) stopSession(true);
    }
  }
  std::mutex sessionMutex_;
  std::unique_ptr<Session> session_;
  std::atomic<bool> shuttingDown_{false};
  std::thread eventThread_;
  bool simulate_ = false;
#ifdef BANDBUDDY_PORTAUDIO_WASAPI
  bool portAudioInitialized_ = false;
#endif
};
} // namespace

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--self-test") {
    Session session;
    session.sampleRate = 48000;
    session.bufferFrames = 128;
    session.inputChannels = 2;
    session.outputChannels = 2;
    session.playbackRate = 1;
    session.bpm = 120;
    session.metronome = true;
    session.countInBeats = 4;
    session.backing = WaveData{48000, 2, std::vector<float>(48000 * 2, 0.0f)};
    std::vector<float> input(session.bufferFrames * session.inputChannels, 0.0f);
    std::vector<float> output(session.bufferFrames * session.outputChannels, 0.0f);
    for (unsigned frame = 0; frame < session.bufferFrames; ++frame) {
      input[frame * 2] = 0.25f;
      input[frame * 2 + 1] = -0.125f;
    }
    const auto countInResult = audioCallback(output.data(), input.data(), session.bufferFrames, 0, 0, &session);
    const bool countInSilent = countInResult == 0 && session.transportFrames.load() == 0
      && session.inputFrames.load() == 0 && !session.recording.load();
    session.callbackFrames.store(session.countInFrames());
    const auto recordingResult = audioCallback(output.data(), input.data(), session.bufferFrames, 0, RTAUDIO_INPUT_OVERFLOW, &session);
    const bool channelMapping = recordingResult == 0 && session.transportFrames.load() == session.bufferFrames
      && std::abs(session.peak[0].load() - 0.25f) < 0.0001f && std::abs(session.peak[1].load() - 0.125f) < 0.0001f;
    const bool xrunCounted = session.xruns.load() == 1;
    const bool ok = countInSilent && channelMapping && xrunCounted;
    emit({{"ok", ok}, {"name", "bandbuddy-audio-host"}, {"protocolVersion", 1},
      {"tests", {{"countInDoesNotRecord", countInSilent}, {"channelMapping", channelMapping}, {"xrunCounted", xrunCounted}}}});
    return ok ? 0 : 1;
  }
  const bool simulate = argc > 1 && std::string(argv[1]) == "--simulate";
  Host host(simulate);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    json request;
    try {
      request = json::parse(line);
      const auto id = request.value("id", 0);
      const auto method = request.value("method", "");
      const auto params = request.value("params", json::object());
      json result;
      if (method == "devices") result = host.devices();
      else if (method == "start") result = host.start(params, false);
      else if (method == "startTest") result = host.start(params, true);
      else if (method == "pause") result = host.pauseSession();
      else if (method == "resume") result = host.resumeSession();
      else if (method == "stop" || method == "stopTest" || method == "cancel") result = host.stopSession(false);
      else if (method == "shutdown") { result = true; emit({{"id", id}, {"ok", true}, {"result", result}}); break; }
      else throw std::runtime_error("UNKNOWN_METHOD");
      emit({{"id", id}, {"ok", true}, {"result", result}});
    } catch (const std::exception& error) {
      emit({{"id", request.value("id", 0)}, {"ok", false}, {"error", error.what()}});
    }
  }
  return 0;
}
