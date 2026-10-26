#pragma once
#include "classic.h"
#include <array>
#include <complex>
#include <memory>
#include <string_view>

namespace bb::ampcab {
// Model provenance, units and reductions: docs/amp-cab-models.md.
struct Speaker {
  double re, le, mass, compliance, bl, qms, area;
  std::array<std::array<double,3>,3> peaks; // Hz, dB, Q
  double rolloff, rolloffQ;
};
struct CabinetProfile { Speaker speaker; unsigned series, parallel; bool sealed; double litres; };
CabinetProfile cabinetProfile(classic::CabinetKind kind);
classic::AmpKind ampKind(std::string_view id);
classic::CabinetKind cabKind(std::string_view id);
bool modeled(classic::AmpKind kind);
bool modeled(classic::CabinetKind kind);

// Trapezoidal three-state electromechanical port, SI units. Linear load and
// radiation share the same parameter source; no output EQ masquerades as load.
class SpeakerPort {
  CabinetProfile profile;
  std::array<std::array<double,3>,3> transition{};
  std::array<double,3> excitation{}, state{}, base{};
  double previousInput=0;
public:
  SpeakerPort(double rate, CabinetProfile p);
  void predict();
  double admittance() const;
  double historyCurrent() const;
  double current(double terminalVolts) const;
  double commit(double terminalVolts); // cone velocity, m/s
  std::complex<double> impedance(double frequency) const;
  const CabinetProfile& parameters() const { return profile; }
};

class Head {
public:
  static constexpr unsigned latencyFrames=32;
  Head(unsigned rate, const classic::AmpControls&, classic::CabinetKind load, double litres);
  ~Head();
  void update(const classic::AmpControls&);
  float tick(float);
  double powerResidualVolts() const;
  double tubeResidualAmps() const;
private:
  struct Impl; std::unique_ptr<Impl> impl;
};
class Cabinet {
public:
  Cabinet(unsigned rate, const classic::CabinetControls&);
  ~Cabinet();
  void update(const classic::CabinetControls&);
  float tick(float);
private:
  struct Impl; std::unique_ptr<Impl> impl;
};
// Exposed only for numerical verification of the prepared current surface.
double interpolatedTriodeCurrent(double plateCathode, double gridCathode);
}
