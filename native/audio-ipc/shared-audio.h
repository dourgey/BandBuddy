#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#endif

namespace bb::ipc {
constexpr unsigned version = 1, quantum = 128, depth = 4, capacity = 128;
static_assert(std::atomic<std::uint32_t>::is_always_lock_free);
struct Block {
  std::uint64_t generation = 0, sequence = 0, samplePosition = 0, continuousPosition = 0;
  double sampleRate = 48000, tempo = 120, projectTimeMusic = 0;
  std::uint32_t frames = quantum, channels = 2, playing = 0, error = 0;
  std::array<float, quantum * 2> samples{};
};
struct Queue {
  alignas(64) std::atomic<std::uint32_t> read{0};
  alignas(64) std::atomic<std::uint32_t> write{0};
  std::array<Block, capacity> blocks{};
  bool push(const Block& block) noexcept {
    const auto w = write.load(std::memory_order_relaxed);
    if (w - read.load(std::memory_order_acquire) >= capacity) return false;
    blocks[w % capacity] = block;
    write.store(w + 1, std::memory_order_release); return true;
  }
  const Block* front() const noexcept {
    const auto r = read.load(std::memory_order_relaxed);
    return r == write.load(std::memory_order_acquire) ? nullptr : &blocks[r % capacity];
  }
  void pop() noexcept { read.store(read.load(std::memory_order_relaxed) + 1, std::memory_order_release); }
};
struct SharedAudio {
  std::uint32_t magic = 0x42424155, protocol = version, bytes = sizeof(SharedAudio), reserved = 0;
  std::uint64_t generation = 0;
  alignas(64) std::atomic<std::uint32_t> ready{0}, shutdown{0}, heartbeat{0}, latency{0}, fault{0};
  Queue input, output;
};
// The supervisor chooses an unpredictable file name in a private directory.
// Create only with exclusive-create; never truncate an existing mapping.
class Mapping {
 public:
  Mapping(const std::filesystem::path& path, bool create, std::uint64_t generation = 0) {
#ifdef _WIN32
    file_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, create ? CREATE_NEW : OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) throw std::runtime_error("PLUGIN_IPC_OPEN_FAILED");
    if (create) { LARGE_INTEGER length{}; length.QuadPart = sizeof(SharedAudio); SetFilePointerEx(file_, length, nullptr, FILE_BEGIN); SetEndOfFile(file_); }
    LARGE_INTEGER length{}; GetFileSizeEx(file_, &length);
    if (length.QuadPart != sizeof(SharedAudio)) { CloseHandle(file_); throw std::runtime_error("PLUGIN_IPC_SIZE_INVALID"); }
    mapping_ = CreateFileMappingW(file_, nullptr, PAGE_READWRITE, 0, 0, nullptr);
    data_ = mapping_ ? static_cast<SharedAudio*>(MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedAudio))) : nullptr;
#else
    fd_ = ::open(path.c_str(), O_RDWR | (create ? O_CREAT | O_EXCL : 0), 0600);
    if (fd_ < 0) throw std::runtime_error("PLUGIN_IPC_OPEN_FAILED");
    if (create && ftruncate(fd_, sizeof(SharedAudio)) != 0) { ::close(fd_); throw std::runtime_error("PLUGIN_IPC_SIZE_FAILED"); }
    if (lseek(fd_, 0, SEEK_END) != sizeof(SharedAudio)) { ::close(fd_); throw std::runtime_error("PLUGIN_IPC_SIZE_INVALID"); }
    auto* p = mmap(nullptr, sizeof(SharedAudio), PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
    data_ = p == MAP_FAILED ? nullptr : static_cast<SharedAudio*>(p);
#endif
    if (!data_) { close(); throw std::runtime_error("PLUGIN_IPC_MAP_FAILED"); }
    if (create) { new (data_) SharedAudio(); data_->generation = generation; }
    else if (data_->magic != 0x42424155 || data_->protocol != version || data_->bytes != sizeof(SharedAudio)) {
      close(); throw std::runtime_error("PLUGIN_IPC_VERSION_MISMATCH");
    }
  }
  ~Mapping() { close(); }
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  SharedAudio& data() { return *data_; }
 private:
  void close() noexcept {
#ifdef _WIN32
    if (data_) UnmapViewOfFile(data_);
    if (mapping_) CloseHandle(mapping_);
    if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_);
    mapping_ = nullptr; file_ = INVALID_HANDLE_VALUE;
#else
    if (data_) munmap(data_, sizeof(SharedAudio));
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
#endif
    data_ = nullptr;
  }
  SharedAudio* data_ = nullptr;
#ifdef _WIN32
  HANDLE file_ = INVALID_HANDLE_VALUE, mapping_ = nullptr;
#else
  int fd_ = -1;
#endif
};

class Client {
 public:
  explicit Client(const std::filesystem::path& path, unsigned bufferFrames = 128) : mapping_(path, false) {
    if (!mapping_.data().ready.load(std::memory_order_acquire)) throw std::runtime_error("PLUGIN_WORKER_NOT_READY");
    request_.generation = mapping_.data().generation;
    configureBuffer(bufferFrames);
  }
  // Control thread, before the device starts. The bridge must span at least
  // one complete device callback; worker output cannot be needed in the same
  // callback that first submitted its input.
  void configureBuffer(unsigned frames) {
    if (!frames || frames > 8192) throw std::runtime_error("PLUGIN_CALLBACK_SIZE_UNSUPPORTED");
    callbackLimit_ = frames; depth_ = std::max(depth, (frames + quantum - 1) / quantum + 1);
  }
  void process(const float* input, float* output, unsigned frames, unsigned channels,
               std::uint64_t position, double rate, double tempo, bool playing, std::uint64_t continuous = UINT64_MAX, double beatOffsetSeconds = 0) noexcept {
    auto& shared = mapping_.data();
    if (continuous == UINT64_MAX) continuous = position;
    if (frames > callbackLimit_) {
      std::fill_n(output, frames * 2, 0.f); misses.fetch_add(1); lastFaultPosition.store(continuous); logFault(true, continuous); return;
    }
    for (unsigned f = 0; f < frames; ++f) {
      if (!offset_) {
        wet_.fill(0); bool valid = false;
        if (sequence_ >= depth_) {
          const auto expected = sequence_ - depth_;
          // A bounded drain discards stale output. Never replay the last block.
          for (unsigned n = 0; n < capacity; ++n) {
            const auto* block = shared.output.front();
            if (!block || block->sequence > expected) break;
            if (block->sequence == expected && block->generation == request_.generation && !block->error
                && block->frames == quantum && block->channels == 2) { wet_ = block->samples; valid = true; }
            shared.output.pop();
          }
          if (!valid) { misses.fetch_add(1); lastFaultPosition.store(continuous + f); }
          logFault(!valid, continuous + f);
        }
        healthy_ = valid;
        request_.samplePosition = position + (playing ? f : 0);
        request_.continuousPosition = continuous + f;
        request_.sampleRate = rate; request_.tempo = tempo;
        request_.projectTimeMusic = (request_.samplePosition / rate - beatOffsetSeconds) * tempo / 60;
        request_.playing = playing ? 1u : 0u;
      }
      envelope_ += std::clamp((healthy_ ? 1.f : 0.f) - envelope_, -1.f / 32, 1.f / 32);
      for (unsigned c = 0; c < 2; ++c) {
        request_.samples[offset_ * 2 + c] = input[f * channels + std::min(c, channels - 1)];
        // Short ramp to/from silence after a missed block; no loud dry fallback.
        float value = wet_[offset_ * 2 + c];
        if (!std::isfinite(value) || std::abs(value) > 64) { value = 0; invalid.fetch_add(1); }
        if (healthy_) last_[c] = value;
        output[f * 2 + c] = (healthy_ ? value : last_[c]) * envelope_;
      }
      if (++offset_ == quantum) {
        request_.sequence = sequence_++;
        if (!shared.input.push(request_)) { overflows.fetch_add(1); lastFaultPosition.store(continuous + f); }
        offset_ = 0;
      }
    }
  }
  unsigned latency() { return quantum * depth_ + mapping_.data().latency.load(); }
  nlohmann::json faultSummary() const {
    auto result = nlohmann::json::array();
    for (unsigned i = 0; i < faultCount_.load(std::memory_order_acquire); ++i) result.push_back({{"startFrame", faults_[i].start}, {"endFrame", faults_[i].end}});
    const auto start = faultStart_.load(), end = faultEnd_.load();
    if (end > start) result.push_back({{"startFrame", start}, {"endFrame", end}});
    return {{"intervals", result}, {"droppedIntervals", droppedFaults_.load()}, {"clock", "output-samples"}};
  }
  std::atomic<std::uint64_t> misses{0}, overflows{0}, invalid{0}, lastFaultPosition{0};
 private:
  void logFault(bool fault, std::uint64_t position) noexcept {
    if (fault) {
      if (!inFault_) { faultStart_.store(position); inFault_ = true; }
      faultEnd_.store(position + quantum);
    } else if (inFault_) {
      const auto index = faultCount_.load(std::memory_order_relaxed);
      if (index < faults_.size()) { faults_[index] = {faultStart_.load(), faultEnd_.load()}; faultCount_.store(index + 1, std::memory_order_release); }
      else droppedFaults_.fetch_add(1);
      faultEnd_.store(0); inFault_ = false;
    }
  }
  struct Fault { std::uint64_t start = 0, end = 0; };
  std::array<Fault, 256> faults_{};
  std::atomic<unsigned> faultCount_{0}, droppedFaults_{0};
  std::atomic<std::uint64_t> faultStart_{0}, faultEnd_{0};
  bool inFault_ = false;
  Mapping mapping_;
  Block request_{};
  std::array<float, quantum * 2> wet_{};
  std::uint64_t sequence_ = 0;
  unsigned offset_ = 0;
  unsigned depth_ = depth, callbackLimit_ = 128;
  bool healthy_ = false;
  float envelope_ = 0;
  std::array<float, 2> last_{};
};
}
