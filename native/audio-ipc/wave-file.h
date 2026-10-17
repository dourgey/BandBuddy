#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <vector>

namespace bb {
inline std::uint32_t wave32(const char* p) { return std::uint32_t(static_cast<unsigned char>(p[0])) | (std::uint32_t(static_cast<unsigned char>(p[1])) << 8) | (std::uint32_t(static_cast<unsigned char>(p[2])) << 16) | (std::uint32_t(static_cast<unsigned char>(p[3])) << 24); }
inline std::uint64_t wave64(const char* p) { return wave32(p) | (std::uint64_t(wave32(p + 4)) << 32); }
inline void wavePut32(std::ostream& s, std::uint32_t v) { char b[4]; for (unsigned i = 0; i < 4; ++i) b[i] = char(v >> (i * 8)); s.write(b, 4); }
inline void wavePut64(std::ostream& s, std::uint64_t v) { wavePut32(s, std::uint32_t(v)); wavePut32(s, std::uint32_t(v >> 32)); }
// Reserve ds64 space from the beginning so a long capture can be finalized as
// RF64 without moving or overwriting any original audio samples.
inline void writeWaveHeader(std::ostream& stream, unsigned rate, unsigned channels, std::uint64_t bytes) {
  const bool rf64 = bytes > 0xffffffffull - 72;
  stream.write(rf64 ? "RF64" : "RIFF", 4); wavePut32(stream, rf64 ? 0xffffffffu : std::uint32_t(bytes + 72)); stream.write("WAVE", 4);
  stream.write(rf64 ? "ds64" : "JUNK", 4); wavePut32(stream, 28);
  wavePut64(stream, bytes + 72); wavePut64(stream, bytes); wavePut64(stream, bytes / (channels * 4)); wavePut32(stream, 0);
  stream.write("fmt ", 4); wavePut32(stream, 16); wavePut32(stream, 3 | (channels << 16)); wavePut32(stream, rate);
  wavePut32(stream, rate * channels * 4); wavePut32(stream, channels * 4 | (32u << 16));
  stream.write("data", 4); wavePut32(stream, rf64 ? 0xffffffffu : std::uint32_t(bytes));
}
class WaveReader {
 public:
  explicit WaveReader(const std::filesystem::path& path) : file_(path, std::ios::binary) {
    if (!file_) throw std::runtime_error("WAVE_OPEN_FAILED");
    const auto size = std::filesystem::file_size(path); char header[12]{}; file_.read(header, 12);
    const bool rf64 = std::memcmp(header, "RF64", 4) == 0;
    if ((!rf64 && std::memcmp(header, "RIFF", 4)) || std::memcmp(header + 8, "WAVE", 4)) throw std::runtime_error("WAVE_HEADER_INVALID");
    std::uint64_t ds64 = 0; unsigned format = 0, bits = 0;
    for (unsigned n = 0; n < 4096 && file_; ++n) {
      char h[8]{}; file_.read(h, 8); if (file_.gcount() != 8) break; auto length = std::uint64_t(wave32(h + 4));
      const auto offset = std::uint64_t(file_.tellg());
      if (std::memcmp(h, "ds64", 4) == 0) { char d[28]{}; if (length < 28) throw std::runtime_error("WAVE_DS64_INVALID"); file_.read(d, 28); ds64 = wave64(d + 8); }
      else if (std::memcmp(h, "fmt ", 4) == 0) {
        if (length < 16 || length > 65536) throw std::runtime_error("WAVE_FORMAT_INVALID");
        std::vector<char> fmt(length); file_.read(fmt.data(), length); format = wave32(fmt.data()) & 65535; channels_ = wave32(fmt.data()) >> 16;
        rate_ = wave32(fmt.data() + 4); bits = wave32(fmt.data() + 12) >> 16;
        if (format == 65534 && length >= 40 && wave32(fmt.data() + 24) == 3) format = 3;
      } else if (std::memcmp(h, "data", 4) == 0) {
        if (rf64 && length == 0xffffffffu) length = ds64;
        if (length > size || offset > size - length) throw std::runtime_error("WAVE_TRUNCATED");
        dataOffset_ = offset; dataBytes_ = length; break;
      }
      if (length > size || offset > size - length) throw std::runtime_error("WAVE_CHUNK_INVALID");
      file_.seekg(offset + length + (length & 1));
    }
    if (format != 3 || bits != 32 || channels_ < 1 || channels_ > 2 || rate_ < 8000 || !dataOffset_ || dataBytes_ % (channels_ * 4)) throw std::runtime_error("WAVE_FLOAT32_REQUIRED");
  }
  unsigned rate() const { return rate_; }
  unsigned channels() const { return channels_; }
  std::uint64_t frames() const { return dataBytes_ / (channels_ * 4); }
  unsigned read(std::uint64_t position, float* output, unsigned frames) {
    const auto count = unsigned(std::min<std::uint64_t>(frames, position < this->frames() ? this->frames() - position : 0));
    std::fill_n(output, frames * channels_, 0.f); if (!count) return 0;
    file_.clear(); file_.seekg(dataOffset_ + position * channels_ * 4);
    file_.read(reinterpret_cast<char*>(output), count * channels_ * 4);
    if (file_.gcount() != count * channels_ * 4) throw std::runtime_error("WAVE_EARLY_EOF");
    return count;
  }
 private:
  std::ifstream file_; unsigned rate_ = 0, channels_ = 0; std::uint64_t dataOffset_ = 0, dataBytes_ = 0;
};
}
