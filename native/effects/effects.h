#pragma once
#include <memory>
#include <string>
#include <nlohmann/json.hpp>
namespace bb {
// Fixed 128-frame adapter; raw capture never enters this buffer.
class Effects {
 public:
  Effects(const nlohmann::json& prepared, unsigned rate);
  ~Effects();
  void update(const nlohmann::json& chain); // control thread / worklet boundary only
  void process(const float* input, float* output, unsigned frames, unsigned channels);
  unsigned latency() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
}
