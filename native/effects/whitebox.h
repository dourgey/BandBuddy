#pragma once
#include <array>

namespace bb::whitebox {
// Revision 1: documented reduced circuits, not measured replicas of a serial-numbered unit.
enum class Device { TS808, SD1, RAT };
struct Controls {
  bool enabled = false;
  Device device = Device::TS808;
  double drive = .4, tone = .5, level = .7, inputVolts = 1;
  unsigned oversampling = 4;
};

// Trapezoidal RC companion; charge state survives coefficient changes.
struct Lowpass {
  double state = 0;
  double tick(double input, double g) {
    const double delta = (input - state) * g / (1 + g);
    const double output = state + delta;
    state = output + delta;
    return output;
  }
};

// G*v + Is*(exp(v/nVt)-exp(-v/mVt)) = current.
// Monotonic scalar MNA port. Bracketed Newton, bounded work and bisection fallback.
struct DiodePort {
  double voltage = 0, residual = 0;
  unsigned fallbacks = 0;
  double solve(double conductance, double current, unsigned negativeDiodes = 1);
};

class Drive {
 public:
  static constexpr unsigned latencyFrames = 32;
  Drive(unsigned sampleRate, const Controls& controls);
  void update(const Controls& controls); // numerical controls only, structural changes require a new instance
  float tick(float input);
 private:
  static constexpr unsigned maxTaps = 129;
  unsigned factor, taps, upPosition = 0, downPosition = 0, dryPosition = 0;
  double rate, smoothing, wet, drive, tone, level, volts;
  Controls target;
  std::array<double, maxTaps> kernel{}, downHistory{};
  std::array<double, 33> upHistory{};
  std::array<float, latencyFrames> dryHistory{};
  Lowpass inputCoupling, ground1, ground2, feedbackFilter, bandwidth, outputCoupling, ratFilter;
  Lowpass toneC1, toneC2, sdPost, finalCoupling;
  DiodePort feedback, shunt;
  double feedbackHistory = 0, slew = 0;
  double circuit(double input);
  double toneNetwork(double input);
};
}
