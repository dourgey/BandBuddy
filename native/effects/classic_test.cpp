#include "classic.h"
#include <cmath>
#include <complex>
#include <iostream>
#include <stdexcept>
#include <chrono>
using namespace bb::classic;
namespace {
constexpr double pi=3.14159265358979323846;
void check(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
template<class P> double response(P& p,unsigned rate,double hz,double amplitude=.01) {
  double sum=0;for(unsigned n=0;n<rate*2;++n){const double y=p.tick(float(amplitude*std::sin(2*pi*hz*n/rate)));check(std::isfinite(y),"Nonfinite response");if(n>=rate)sum+=y*y;}
  return std::sqrt(2*sum/rate)/amplitude;
}
}
int main() {
 try {
  for(double rk:{820.,1500.,10000.})for(double ck:{0.,.68e-6,25e-6}) {
    TriodeStage tube;tube.init(192000,rk,ck);
    check(tube.dcPlate>0&&tube.dcPlate<300,"Invalid DC operating point");
    for(int i=0;i<10000;++i){const double y=tube.tick(10*std::sin(i*.13));check(std::isfinite(y)&&std::abs(tube.residual)<1e-8,"Triode load-line KCL residual");}
  }
  // Independent continuous-time C12N voltage -> far-field pressure transfer.
  for(auto kind:{CabinetKind::Open112,CabinetKind::Open212,CabinetKind::Sealed412})for(double hz:{50.,113.,440.,2000.}) {
    const double count=kind==CabinetKind::Sealed412?4:kind==CabinetKind::Open212?2:1;
    using C=std::complex<double>;const C s(0,2*pi*hz);
    const double k=1/.000066+(kind==CabinetKind::Sealed412?1.204*343*343*.04909*.04909*count/.08:0);
    const C zm=.0299*s+std::sqrt(.0299/.000066)/7.52+k/s;
    C h=(10.46/zm)/(6.05+s*.0009+10.46*10.46/zm)*s*(1.204*.04909*count/(2*pi))*2.;
    if(kind!=CabinetKind::Sealed412)h*=s/(s+2*pi*180.);
    h/=std::pow(1.+s/(2*pi*5000.),2);
    CabinetControls c;c.kind=kind;c.enabled=true;Cabinet p(192000,c);
    const double actual=response(p,192000,hz),expected=std::abs(h);
    check(std::abs(actual/expected-1)<.02,"Physical cabinet disagrees with analog mechanical/electrical transfer");
    std::cout<<"Cabinet "<<int(kind)<<" "<<hz<<" Hz gain="<<actual<<" expected="<<expected<<"\n";
  }
  // Four equal allpass stages + 50:50 mix must create the two script-network notches.
  for(double hz:{30.,std::tan(pi/8)/(2*pi*24000*47e-9),std::tan(3*pi/8)/(2*pi*24000*47e-9),1000.}) {
    using C=std::complex<double>;const C s(0,2*pi*hz);
    C h=.5*(1.+std::pow((1.-s*24000.*47e-9)/(1.+s*24000.*47e-9),4));
    h*=s*470000.*10e-9/(1.+s*470000.*10e-9)*s*150000.*47e-9/(1.+s*150000.*47e-9);
    ModControls c;c.enabled=true;c.depth=0;Modulation p(192000,c);
    const double actual=response(p,192000,hz);
    check(std::abs(actual-std::abs(h))<.002,"Phase90 notch locations incorrect");
  }
  for(unsigned sr:{8000u,44100u,48000u,96000u,192000u}) {
    for(auto kind:{ModKind::Phase90,ModKind::OpticalTremolo,ModKind::Chorus,ModKind::Flanger,ModKind::Wah,ModKind::Compressor}) {
      ModControls c;c.kind=kind;Modulation p(sr,c);
      for(int n=0;n<200;++n){float x=float(std::sin(n*.4));check(p.tick(x)==x,"Modulation bypass changed dry PCM");}
      c.enabled=true;c.depth=1;c.feedback=.85;c.rateHz=10;p.update(c);
      for(unsigned n=0;n<sr;++n){double y=p.tick(n<sr/2?float(std::sin(n*.7)):0);check(std::isfinite(y)&&std::abs(y)<20,"Modulation unbounded");}
      c.enabled=false;p.update(c);for(unsigned n=0;n<sr;++n)p.tick(0);check(p.tick(.1f)==.1f,"Modulation bypass did not settle");
    }
    for(auto kind:{AmpKind::AB763,AmpKind::Lead2203}) {
      AmpControls c;c.kind=kind;Amp p(sr,c);
      for(int n=0;n<256;++n){const float x=n==0?.1f:0;check(p.tick(x)==(n==32?.1f:0),"Amp bypass latency differs");}
      c.enabled=true;c.gain=1;c.master=1;c.inputVolts=10;p.update(c);
      for(unsigned n=0;n<sr/4;++n){if(n%128==0){c.bass=(n%256)?1:0;c.treble=1-c.bass;p.update(c);}const double y=p.tick(float(.5*std::sin(n*.3)));check(std::isfinite(y)&&std::abs(y)<20,"Amp stress unbounded");}
    }
  }
  // Every amplifier has state independent of every other instance.
  AmpControls c;c.enabled=true;Amp a(48000,c),b(48000,c);
  double energy=0;const auto start=std::chrono::steady_clock::now();
  for(int n=0;n<48000;++n){const double y=a.tick(float(.1*std::sin(n*.03)));energy+=y*y;check(std::abs(b.tick(0))<1e-7,"Independent amp leaked audio");}
  check(energy>1e-8,"Amplifier produced silence");
  std::cout<<"Stereo 1s amp CPU seconds: "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<"\n";
  std::cout<<"Classic: operating points, KCL, analog cabinet response, phase notches, rates, independent state, bypass and stability passed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
