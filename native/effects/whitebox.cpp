#include "whitebox.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bb::whitebox {
namespace {
constexpr double pi = 3.14159265358979323846;
constexpr double saturationCurrent = 2.52e-9;
constexpr double nVt = 1.752 * .02585; // nominal silicon diode, 25 C; not a fitted device
struct Evaluation { double residual, derivative; };
Evaluation evaluate(double v, double g, double current, unsigned negative) {
  const double p = std::exp(v / nVt), n = std::exp(-v / (nVt * negative));
  return {g * v + saturationCurrent * (p - n) - current,
          g + saturationCurrent / nVt * (p + n / negative)};
}
double pot(double x) { return (std::pow(10., 2 * x) - 1) / 99; }
}

double DiodePort::solve(double g, double current, unsigned negative) {
  // At the allowed signal levels, the root is always inside +/-4 V.
  double lo = -4, hi = 4, v = std::clamp(voltage, lo, hi);
  for (unsigned k = 0; k < 12; ++k) {
    const auto e = evaluate(v, g, current, negative);
    if (std::abs(e.residual) < 1e-11) { residual = e.residual; return voltage = v; }
    if (e.residual > 0) hi = v; else lo = v;
    const double next = v - e.residual / e.derivative;
    v = next > lo && next < hi ? next : (lo + hi) * .5;
  }
  ++fallbacks;
  for (unsigned k = 0; k < 32; ++k) {
    v = (lo + hi) * .5;
    if (evaluate(v, g, current, negative).residual > 0) hi = v; else lo = v;
  }
  residual = evaluate(v, g, current, negative).residual;
  return voltage = v;
}

Drive::Drive(unsigned sr, const Controls& c)
    : factor(c.oversampling), taps(32 * factor + 1), rate(double(sr) * factor),
      smoothing(1 - std::exp(-1. / (.01 * sr))), wet(c.enabled ? 1 : 0),
      drive(c.drive), tone(c.tone), level(c.level), volts(c.inputVolts), target(c) {
  if ((factor != 2 && factor != 4) || sr < 8000 || sr > 192000)
    throw std::invalid_argument("WHITEBOX_UNSUPPORTED_RATE");
  // Blackman-windowed sinc, 16 base-rate samples group delay on each side.
  const double cutoff = .45 / factor;
  double sum = 0;
  for (unsigned k = 0; k < taps; ++k) {
    const double d = double(k) - (taps - 1) * .5;
    const double sinc = d == 0 ? 2 * cutoff : std::sin(2 * pi * cutoff * d) / (pi * d);
    kernel[k] = sinc * (.42 - .5 * std::cos(2 * pi * k / (taps - 1)) + .08 * std::cos(4 * pi * k / (taps - 1)));
    sum += kernel[k];
  }
  for (auto& k : kernel) k /= sum;
}

void Drive::update(const Controls& c) {
  if (c.device != target.device || c.oversampling != factor)
    throw std::invalid_argument("WHITEBOX_REBUILD_REQUIRED");
  target = c;
}

double Drive::toneNetwork(double input) {
  // Ideal op-amp, loaded passive input RC and tone pot between +/- inputs.
  // Eliminate the linear nodes analytically. C1 and C2 keep trapezoidal companion states.
  const bool sd = target.device == Device::SD1;
  const double rIn = sd ? 10000 : 1000, c1 = sd ? 18e-9 : 220e-9;
  const double rSeries = sd ? 470 : 220, c2 = sd ? 27e-9 : 220e-9;
  const double rFeedback = sd ? 10000 : 1000, rPot = 20000;
  const double rPlus = 1 + rPot * tone, rMinus = 1 + rPot * (1 - tone);
  const double g1 = 2 * rate * c1, g2 = 2 * rate * c2;
  const double rParallel = 1 / (1 / rPlus + 1 / rMinus);
  const double rPath = rParallel + rSeries;
  // i2 = (p - oldCompanionC2) / (rPath + 1/g2)
  const double y2 = 1 / (rPath + 1 / g2);
  const double p = (input / rIn + g1 * toneC1.state + y2 * toneC2.state) / (1 / rIn + g1 + y2);
  const double i2 = y2 * (p - toneC2.state);
  const double c2Voltage = toneC2.state + i2 / g2;
  toneC1.state = 2 * p - toneC1.state;
  toneC2.state = 2 * c2Voltage - toneC2.state;
  double output = p + rFeedback * i2 * rParallel / rMinus;
  // SD-1 post-tone pole is a reduced representation, documented as such.
  if (sd) output = sdPost.tick(output, 1 / (2 * rate * 10000 * 10e-9));
  return output;
}

double Drive::circuit(double input) {
  const bool rat = target.device == Device::RAT;
  // Buffered source after the ADC: these filters do not claim to restore pickup loading.
  const double u = input - inputCoupling.tick(input, 1 / (2 * rate * (rat ? 1e6 * 22e-9 : 510e3 * 20e-9)));
  double output;
  if (!rat) {
    const bool sd = target.device == Device::SD1;
    const double rf = sd ? 33000 + 1e6 * drive : 51000 + 500000 * pot(drive);
    const double branchCurrent = (u - ground1.tick(u, 1 / (2 * rate * 4700 * 47e-9))) / 4700;
    const double gc = 2 * rate * (sd ? 100e-12 : 51e-12);
    const double w = feedback.solve(1 / rf + gc, branchCurrent - feedbackHistory, sd ? 2 : 1);
    const double capacitorCurrent = gc * w + feedbackHistory;
    feedbackHistory = -gc * w - capacitorCurrent;
    output = toneNetwork(std::clamp(u + w, -4., 4.));
  } else {
    const double rf = 1 + 100000 * pot(drive);
    const double i1 = (u - ground1.tick(u, 1 / (2 * rate * 47 * 2.2e-6))) / 47;
    const double i2 = (u - ground2.tick(u, 1 / (2 * rate * 560 * 4.7e-6))) / 560;
    const double desired = u + feedbackFilter.tick(rf * (i1 + i2), 1 / (2 * rate * rf * 100e-12));
    // LM308-style reduced GBW (1 MHz) and slew (0.3 V/us), with 9 V supply headroom.
    const double closedLoopGain = 1 + rf * (1 / 47. + 1 / 560.);
    const double limited = bandwidth.tick(desired, std::tan(pi * std::min(rate * .4, 1e6 / closedLoopGain) / rate));
    slew += std::clamp(std::clamp(limited, -4., 4.) - slew, -300000 / rate, 300000 / rate);
    // C7 + R6 feeds the diode node; trapezoidal companion couples capacitor and nonlinear port.
    const double gc = 2 * rate * 4.7e-6, r = 1000;
    const double equivalentR = r + 1 / gc;
    const double v = shunt.solve(1 / equivalentR + 1 / 1e6, (slew - outputCoupling.state) / equivalentR);
    const double capV = slew - v - r * (slew - v - outputCoupling.state) / equivalentR;
    outputCoupling.state = 2 * capV - outputCoupling.state;
    output = ratFilter.tick(v, 1 / (2 * rate * (1500 + 100000 * pot(tone)) * 3.3e-9));
  }
  output -= finalCoupling.tick(output, 1 / (2 * rate * (target.device == Device::SD1 ? 10000 : 100000) * 1e-6));
  // Hardware Level and the software's final output gain remain independent.
  output *= pot(level);
  return std::isfinite(output) ? output : 0;
}

float Drive::tick(float input) {
  const float safe = std::isfinite(input) ? input : 0;
  const float dry = dryHistory[dryPosition];
  dryHistory[dryPosition] = safe;
  dryPosition = (dryPosition + 1) % latencyFrames;
  drive += (target.drive - drive) * smoothing;
  tone += (target.tone - tone) * smoothing;
  level += (target.level - level) * smoothing;
  volts += (target.inputVolts - volts) * smoothing;
  wet += ((target.enabled ? 1 : 0) - wet) * smoothing;
  if (std::abs(wet - (target.enabled ? 1 : 0)) < 1e-8) wet = target.enabled ? 1 : 0;
  upHistory[upPosition] = std::clamp(double(safe) * volts, -20., 20.);
  double result = 0;
  for (unsigned phase = 0; phase < factor; ++phase) {
    double up = 0;
    for (unsigned k = phase, age = 0; k < taps; k += factor, ++age)
      up += kernel[k] * upHistory[(upPosition + upHistory.size() - age) % upHistory.size()] * factor;
    downHistory[downPosition] = circuit(up);
    // Sample at phase zero: combined FIR group delay is exactly 32 base-rate samples.
    if (phase == 0) for (unsigned k = 0; k < taps; ++k)
      result += kernel[k] * downHistory[(downPosition + maxTaps - k) % maxTaps];
    downPosition = (downPosition + 1) % maxTaps;
  }
  upPosition = (upPosition + 1) % upHistory.size();
  return float(dry * (1 - wet) + (result / volts) * wet);
}
}
