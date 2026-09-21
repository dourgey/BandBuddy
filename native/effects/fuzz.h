#pragma once
#include <array>
namespace bb::whitebox {
// Silicon-polarity Fuzz Face study; nominal Ebers-Moll transistors, buffered ADC source.
class FuzzCircuit {
 public:
  void init(double sampleRate, double fuzz=.5);
  double tick(double input, double fuzz);
  double residual() const { return error; }
  unsigned failedSteps() const { return failures; }
 private:
  std::array<double,5> nodes{.6,1.1,.5,4.5,8.8};
  double rate=192000, inputHistory=0, emitterHistory=0, outputHistory=0, error=0, lastOutput=0;
  unsigned failures=0;
  bool solve(double input, double fuzz, bool dc);
};
}
