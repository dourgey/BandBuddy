#include "whitebox.h"
#include "effects.h"
#include <algorithm>
#include <cmath>
#include <complex>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace bb::whitebox;
namespace {
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
std::vector<float> render(Device device, unsigned rate, unsigned factor, double tone = .5, double amplitude = .5) {
  Controls c; c.device=device;c.enabled=true;c.drive=.6;c.tone=tone;c.oversampling=factor;
  Drive processor(rate,c);std::vector<float> output(rate/8);
  for(size_t i=0;i<output.size();++i) {
    const float x=float(amplitude*std::sin(2*3.141592653589793*997*i/rate));
    output[i]=processor.tick(x);check(std::isfinite(output[i]) && std::abs(output[i])<12,"Unbounded circuit output");
  }
  return output;
}
double energy(const std::vector<float>& x) {double s=0;for(size_t i=x.size()/2;i<x.size();++i)s+=x[i]*x[i];return s/(x.size()/2);}
}
int main(int argc, char** argv) {
 try {
  if(argc==5) {
    std::ifstream manifest(argv[1]);nlohmann::json spec;manifest>>spec;
    std::ifstream input(argv[2],std::ios::binary|std::ios::ate);const auto bytes=input.tellg();input.seekg(0);
    std::vector<float> source(size_t(bytes)/sizeof(float));input.read(reinterpret_cast<char*>(source.data()),bytes);
    const auto untouched=source;
    bb::Effects processor(spec,48000);std::vector<float> output(source.size());
    const unsigned chunk=std::stoul(argv[4]);
    for(size_t p=0;p<source.size()/2;p+=chunk) processor.process(source.data()+p*2,output.data()+p*2,std::min(size_t(chunk),source.size()/2-p),2);
    check(source==untouched,"DSP modified dry input");
    std::ofstream result(argv[3],std::ios::binary);result.write(reinterpret_cast<const char*>(output.data()),output.size()*sizeof(float));
    std::cout<<"latency="<<processor.latency()<<"\n";return 0;
  }
  for(unsigned sr:{16000u,48000u,192000u,768000u}) {
    FuzzCircuit f;f.init(sr);double total=0;
    for(unsigned n=0;n<20000;++n){const double y=f.tick(20*std::sin(n*.1),n%512<256?0:1);total+=y*y;check(std::isfinite(y)&&std::abs(y)<10,"Fuzz unbounded output");}
    check(f.failedSteps()==0&&f.residual()<1e-8&&total>0,"Fuzz coupled-transistor solver failed");
  }
  // Independent KCL residual over nominal dynamic port currents, including abrupt reversals.
  for(unsigned count:{1u,2u}) {
    DiodePort port;
    for(double g:{1./551000,1./33000,.001,.02}) for(double i:{0.,.01,-.02,1e-7,-1e-7,.1,-.1}) {
      double v=port.solve(g,i,count);
      double residual=g*v+2.52e-9*(std::exp(v/(1.752*.02585))-std::exp(-v/(count*1.752*.02585)))-i;
      check(std::isfinite(v)&&std::abs(residual)<1e-7,"KCL residual exceeded tolerance");
    }
  }
  // Independent continuous-time small-signal TS808 network vs time-domain solver.
  // Includes diode differential conductance at zero; 192 kHz base rate makes warping negligible.
  for(double hz:{50.,440.,2000.}) {
    using Z=std::complex<double>; const Z s(0,2*3.141592653589793*hz);
    const double rf=51000+500000*(std::pow(10.,.8)-1)/99;
    const Z gainStage=1.+(s*47e-9/(1.+s*4700.*47e-9))/(1./rf+s*51e-12+2*2.52e-9/(1.752*.02585));
    const double rPlus=10001,rMinus=10001,rParallel=5000.5;
    const Z path=1./(rParallel+220.+1./(s*220e-9));
    const Z toneStage=(1./1000)/(1./1000+s*220e-9+path)*(1.+1000.*path*rParallel/rMinus);
    const Z inputHP=s*510e3*20e-9/(1.+s*510e3*20e-9),outputHP=s*.1/(1.+s*.1);
    const double expected=std::abs(inputHP*gainStage*toneStage*outputHP)*(std::pow(10.,1.4)-1)/99;
    Controls c;c.enabled=true;Drive d(192000,c);double sum=0;
    for(unsigned n=0;n<384000;++n) {double y=d.tick(float(1e-4*std::sin(2*3.141592653589793*hz*n/192000)));if(n>=192000)sum+=y*y;}
    const double actual=std::sqrt(2*sum/192000)/1e-4;
    std::cout<<"TS sweep "<<hz<<" Hz: measured="<<actual<<" expected="<<expected<<"\n";
    check(std::abs(actual/expected-1)<.02,"TS small-signal response differs from analog network");
  }
  for(unsigned factor:{2u,4u}) {
    Controls c;c.oversampling=factor;Drive bypass(48000,c);
    std::vector<float> input(2000);for(size_t i=0;i<input.size();++i)input[i]=float(std::sin(i*.12));
    for(size_t i=0;i<input.size();++i)check(bypass.tick(input[i])==(i<32?0:input[i-32]),"Bypass must be an exact delayed dry sample");
    for(auto device:{Device::TS808,Device::SD1,Device::RAT,Device::MicroAmp,Device::DistortionPlus,Device::FuzzFace}) for(unsigned sr:{44100u,48000u,96000u,192000u}) render(device,sr,factor);
  }
  for(auto device:{Device::TS808,Device::SD1,Device::RAT,Device::MicroAmp,Device::DistortionPlus,Device::FuzzFace}) {
    Controls c;c.enabled=true;c.device=device;Drive changing(48000,c);
    for(unsigned n=0;n<48000;++n) {
      if(n%128==0) {c.drive=(n%256)?0:1;c.tone=1-c.drive;c.level=c.drive;c.inputVolts=c.drive?10:.1;changing.update(c);}
      check(std::isfinite(changing.tick(float(std::sin(n*.9)))),"Parameter update unstable");
    }
    c.enabled=false;changing.update(c);
    for(unsigned n=0;n<48000;++n)check(std::isfinite(changing.tick(0)),"Recovery unstable");
    check(std::abs(changing.tick(0))<1e-6,"Bypass/silence failed to settle");
  }
  check(energy(render(Device::RAT,48000,4,0))>energy(render(Device::RAT,48000,4,1))*2,"RAT Filter direction inverted");
  const auto ts=render(Device::TS808,48000,4),sd=render(Device::SD1,48000,4),rat=render(Device::RAT,48000,4);
  double difference=0;for(size_t i=0;i<ts.size();++i)difference+=std::abs(ts[i]-sd[i])+std::abs(sd[i]-rat[i]);
  check(difference>10,"Circuit families collapsed to identical processing");
  std::cout<<"Whitebox: KCL, bypass, rates, bounded output, parameter smoothing, recovery, Filter direction and family distinction passed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
