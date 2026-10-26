#include "centaur.h"
#include "classic.h"
#include <chrono>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <stdexcept>
#include <vector>

namespace {bool tracking=false;size_t allocations=0;}
void* operator new(std::size_t n){if(tracking)++allocations;if(auto p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void operator delete(void* p)noexcept{std::free(p);}
void operator delete(void* p,std::size_t)noexcept{std::free(p);}
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete[](void* p)noexcept{std::free(p);}
void operator delete[](void* p,std::size_t)noexcept{std::free(p);}
namespace {
constexpr double pi=3.14159265358979323846;
using K=bb::classic::ModKind;
using C=bb::classic::ModControls;
void require(bool ok,const char* reason){if(!ok)throw std::runtime_error(reason);}
void circuitResponse(){
  using Z=std::complex<double>;
  double worst=0;
  // Independent series/parallel impedance reduction, not the nodal solver.
  auto parallel=[](Z a,Z b){return a*b/(a+b);};
  for(unsigned sr:{32000u,96000u,384000u})for(double gain:{.1,.5,.9})for(double hz:{100.,1000.,3000.}){
    bb::pedals::Centaur circuit(sr,gain,.5);std::array<Z,3> measured{};
    for(unsigned n=0;n<sr*3/10;++n){double angle=2*pi*hz*n/sr;circuit.tick(1e-5*std::cos(angle),gain,.5,.7);
      if(n>=sr/5){auto b=circuit.branches();for(int j=0;j<3;++j)measured[j]+=b[j]*Z(std::cos(angle),-std::sin(angle))*(20./sr/1e-5);}}
    const Z s(0,2*sr*std::tan(pi*hz/sr));auto cap=[&](double c){return 1./(s*c);};
    const Z input=1e6/(1010000.+cap(.1e-6));
    const Z ff1Load=parallel(15000.,cap(1e-6));
    const Z preLoad=parallel(parallel(10000.,cap(68e-9))+gain*100000,1500.+ff1Load);
    const Z pre=input*preLoad/(preLoad+cap(.1e-6)),ff1=pre*ff1Load/(1500.+ff1Load)/15000.;
    const Z bottom=parallel(parallel(parallel(27000.,cap(27e-9)+12000.),cap(2.2e-9)+69000.),(1-gain)*100000);
    const Z ffLoad=parallel(parallel(1500.,cap(390e-9)+1000.),gain*100000+bottom);
    const Z ff2=input*ffLoad/(parallel(5100.,cap(68e-9))+ffLoad)*bottom/(gain*100000+bottom)/(cap(2.2e-9)+69000.);
    std::array<Z,3> expected{pre,ff1,ff2};
    for(int j=0;j<3;++j)worst=std::max(worst,std::abs(measured[j]-expected[j])/std::max(1e-12,std::abs(expected[j])));
  }
  std::printf("centaur_passive_branch_complex_relative_error=%.8g\n",worst);
  require(worst<1e-5,"Centaur branch transfer differs from independent component impedances");
  for(double gain:{0.,.5,1.}){bb::pedals::Centaur circuit(192000,gain,.5);tracking=true;
    for(int n=0;n<12000;++n){double y=circuit.tick(20*std::sin(n*.2),gain,.5,.7);require(std::isfinite(y),"Centaur clipping nonfinite");require(std::abs(circuit.clipResidual())<1e-9,"Centaur diode KCL residual");}tracking=false;}
}
void drive(){
  for(unsigned sr:{8000u,44100u,48000u,96000u,192000u})for(unsigned quality:{2u,4u}){
    bb::whitebox::Controls c;c.enabled=true;c.device=bb::whitebox::Device::Centaur;c.oversampling=quality;
    bb::whitebox::Drive processor(sr,c);double energy=0;tracking=true;
    for(unsigned n=0;n<sr/3;++n){if(n%2048==0){c.drive=(n/2048)%2?0:1;c.tone=1-c.drive;processor.update(c);}
      double y=processor.tick(float(2*std::sin(n*.13)));require(std::isfinite(y)&&std::abs(y)<64,"Centaur unbounded during gain sweep");energy+=y*y;}
    require(energy>1e-6,"Centaur silent");
    for(unsigned n=0;n<sr;++n)require(std::isfinite(processor.tick(0)),"Centaur unstable tail");
    require(std::abs(processor.tick(0))<1e-5,"Centaur DC did not decay");
    require(std::isfinite(processor.tick(NAN))&&std::isfinite(processor.tick(INFINITY)),"Centaur nonfinite input");tracking=false;
    c.enabled=false;bb::whitebox::Drive bypass(sr,c);tracking=true;
    for(int n=0;n<1024;++n)require(bypass.tick(n==0?.5f:0.f)==(n==32?.5f:0.f),"Centaur bypass latency not 32 samples");tracking=false;
  }
  bb::whitebox::Controls c;c.enabled=true;c.device=bb::whitebox::Device::Centaur;c.level=.25;bb::whitebox::Drive quiet(48000,c);c.level=.75;bb::whitebox::Drive loud(48000,c);
  double error=0,energy=0;for(int n=0;n<10000;++n){float x=float(.3*std::sin(n*.1));double a=quiet.tick(x),b=loud.tick(x);error+=std::pow(3*a-b,2);energy+=b*b;}
  require(std::sqrt(error/energy)<1e-6,"Centaur level changes the drive circuit");
}
void modulation(){
  for(K kind:{K::StereoChorus,K::StepFlanger,K::AqueductVibrato,K::FixedWah})for(unsigned sr:{8000u,44100u,48000u,96000u,192000u}){
    const unsigned modes=kind==K::AqueductVibrato?8:kind==K::StepFlanger?3:1;
    for(unsigned mode=0;mode<modes;++mode){C c;c.enabled=true;c.kind=kind;c.waveform=mode;c.sweepMode=mode;bb::classic::Modulation processor(sr,c);double energy=0;tracking=true;
      for(unsigned n=0;n<sr/2;++n){if(n%2048==0){bool high=(n/2048)%2;c.rateHz=high?10:0;c.depth=high?1:0;c.feedback=high?.85:-.85;c.manual=c.depth;c.bass=c.treble=c.depth;c.levelDb=high?20:-24;c.mix=high?1:.5;c.bassFilter=high;processor.update(c);}
        double y=processor.tick(float(.2*std::sin(n*.19)));require(std::isfinite(y)&&std::abs(y)<32,"Modulation unstable at control limits");energy+=y*y;}
      require(energy>1e-7,"Modulation silent");
      for(unsigned n=0;n<sr*2;++n)require(std::isfinite(processor.tick(0)),"Modulation tail unstable");
      require(std::abs(processor.tick(0))<1e-5,"Modulation tail failed to decay");
      require(std::isfinite(processor.tick(NAN))&&std::isfinite(processor.tick(INFINITY)),"Modulation nonfinite input");
      c.enabled=false;processor.update(c);for(unsigned n=0;n<sr/3;++n)processor.tick(.1f);require(processor.tick(.1f)==.1f,"Modulation bypass not exact after fade");tracking=false;
    }
  }
}
double response(C c,double hz){bb::classic::Modulation processor(48000,c);double energy=0;for(int n=0;n<48000;++n){double y=processor.tick(float(.1*std::sin(2*pi*hz*n/48000)));if(n>=24000)energy+=y*y;}return std::sqrt(energy/12000)/.1;}
void behavior(){
  C c;c.enabled=true;c.kind=K::FixedWah;c.manual=.5;c.depth=1;
  const double hz=380*std::pow(2000./380,c.manual),center=response(c,hz);
  require(std::abs(center-1)<.002,"Fixed wah center gain");require(response(c,hz/2)<center*.1&&response(c,hz*2)<center*.1,"Fixed wah Q does not reject out of band signal");
  c.manual=1;require(response(c,2000)>.99,"Fixed wah Peak range");c.levelDb=-6;require(std::abs(response(c,2000)-std::pow(10.,-.3))<.002,"Fixed wah Level dB calibration");
  c=C{};c.enabled=true;c.kind=K::StereoChorus;c.depth=.8;c.rateHz=1.3;bb::classic::Modulation left(48000,c,0),right(48000,c,1);double stereo=0;
  for(int n=0;n<48000;++n){float x=float(.2*std::sin(n*.1));stereo+=std::pow(left.tick(x)-right.tick(x),2);}require(stereo>1,"Stereo chorus channels are identical");
  c=C{};c.enabled=true;c.kind=K::StepFlanger;c.rateHz=0;c.depth=.5;c.feedback=.8;bb::classic::Modulation positive(48000,c);c.feedback=-.8;bb::classic::Modulation negative(48000,c);double signedDifference=0;
  for(int n=0;n<48000;++n){float x=n==0?1.f:0.f;signedDifference+=std::pow(positive.tick(x)-negative.tick(x),2);}require(signedDifference>.02,"Flanger feedback polarity has no effect");
  // Full-wet Env P must move the signal's pitch, not just filter its amplitude.
  c=C{};c.enabled=true;c.kind=K::AqueductVibrato;c.waveform=7;c.rateHz=10;c.depth=1;bb::classic::Modulation pitch(48000,c);int crossings=0;double previous=0;
  for(int n=0;n<72000;++n){double y=pitch.tick(float(.4*std::sin(2*pi*1000*n/48000)));if(n>=24000&&previous<=0&&y>0)++crossings;previous=y;}
  std::printf("envelope_pitch_1000Hz_zero_crossing_hz=%d\n",crossings);require(crossings>850&&crossings<950,"Envelope pitch does not bend down");
  c.depth=0;require(std::abs(response(c,1000)-1)<.0001,"Env P zero mix is not dry");
}
void benchmark(){
  auto measure=[](auto& left,auto& right,const char* name){constexpr int count=48000;double sum=0;auto begin=std::chrono::steady_clock::now();tracking=true;
    for(int n=0;n<count;++n){float x=float(.2*std::sin(n*.1));sum+=left.tick(x)+right.tick(x);}tracking=false;
    const double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count();std::printf("%s stereo48k_cpu_percent=%.3f checksum=%.8f\n",name,ms/10,sum);require(ms<1000,"Effect cannot run in real time on test machine");};
  for(unsigned q:{2u,4u}){bb::whitebox::Controls c;c.enabled=true;c.device=bb::whitebox::Device::Centaur;c.oversampling=q;bb::whitebox::Drive left(48000,c),right(48000,c);measure(left,right,q==2?"centaur2x":"centaur4x");}
  for(K kind:{K::StereoChorus,K::StepFlanger,K::AqueductVibrato,K::FixedWah}){C c;c.enabled=true;c.kind=kind;bb::classic::Modulation left(48000,c,0),right(48000,c,1);measure(left,right,kind==K::StereoChorus?"stereo-chorus":kind==K::StepFlanger?"step-flanger":kind==K::AqueductVibrato?"aqueduct-vibrato":"fixed-wah");}
}
}
int main(){try{circuitResponse();drive();modulation();behavior();benchmark();require(allocations==0,"Audio callback allocated memory");std::puts("pedals: PASS; zero callback allocations");return 0;}catch(const std::exception& e){std::fprintf(stderr,"pedals: FAIL: %s\n",e.what());return 1;}}
