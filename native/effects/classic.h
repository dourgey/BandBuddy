#pragma once
#include "whitebox.h"
#include <array>
#include <vector>

namespace bb::classic {
// Circuit studies, not calibrated replicas. See docs/arsenal-classic-models.md.
enum class AmpKind { AB763, Lead2203 };
struct AmpControls {
  bool enabled=false; AmpKind kind=AmpKind::AB763;
  double gain=.35, bass=.5, middle=.5, treble=.5, master=.5, inputVolts=1;
};
// Koren 12AX7 plate-current model, published nominal parameters.
double triodeCurrent(double plateCathode, double gridCathode);
struct TriodeStage {
  double rate=192000, supply=300, rp=100000, rk=1500, ck=25e-6;
  double current=0, cathodeHistory=0, dcPlate=0, residual=0;
  void init(double sr, double cathodeR, double cathodeC, double bPlus=300);
  double tick(double grid);
};
// Loaded FMV passive stack: three capacitors, slope resistor, interacting pots.
class ToneStack {
 public:
  void configure(double sr, bool british, double bass, double middle, double treble);
  double tick(double input);
 private:
  std::array<std::array<double,5>,5> inverse{};
  std::array<double,3> history{}, conductance{};
  double sourceG=0, slopeG=0;
};
class Amp {
 public:
  static constexpr unsigned latencyFrames=32;
  Amp(unsigned sr, const AmpControls& controls);
  void update(const AmpControls& controls);
  float tick(float input);
 private:
  AmpControls target, current;
  double rate, smooth, wet;
  TriodeStage stages[3]; ToneStack stack;
  whitebox::Lowpass coupling[4], miller[3];
  std::array<double,129> kernel{}, down{};
  std::array<double,33> up{};
  std::array<float,32> dry{};
  unsigned upPos=0, downPos=0, dryPos=0, controlClock=0;
  double circuit(double input);
};
enum class CabinetKind { Open112, Open212, Sealed412 };
struct CabinetControls {
  bool enabled=false; CabinetKind kind=CabinetKind::Open112;
  double volumeLitres=80, distanceMetres=1, micAngle=0;
};
// Jensen C12N 8-ohm nominal Thiele/Small data; linear piston + enclosure.
class Cabinet {
 public:
  Cabinet(unsigned sr, const CabinetControls& controls);
  void update(const CabinetControls& controls);
  float tick(float input);
  double displacement() const { return state[2]; }
 private:
  double rate, smooth, wet=0;
  CabinetControls target, current;
  std::array<double,3> state{}; // coil current A, cone velocity m/s, displacement m
  std::array<std::array<double,3>,3> transition{};
  std::array<double,3> excitation{};
  whitebox::Lowpass radiation, aperture[2];
  double previousInput=0, previousVelocity=0;
  unsigned clock=0;
  void coefficients();
};
enum class ModKind { Phase90, OpticalTremolo, Chorus, Flanger, Wah, Compressor };
struct ModControls {
  bool enabled=false; ModKind kind=ModKind::Phase90;
  double rateHz=.7, depth=.6, mix=.5, feedback=.3, manual=.5;
};
class Modulation {
 public:
  Modulation(unsigned sr, const ModControls& controls);
  void update(const ModControls& controls);
  float tick(float input);
 private:
  double rate, smooth, phase=0, wet=0, envelope=0, ldr=0, wah1=0, wah2=0;
  ModControls target, current;
  whitebox::Lowpass inputCoupling, outputCoupling, allpass[4], antiAlias[2], reconstruction[2];
  std::vector<double> delay;
  unsigned position=0;
};
}
