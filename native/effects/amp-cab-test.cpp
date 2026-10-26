#include "amp-cab.h"
#include "cabinet-ir.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <random>
#include <stdexcept>
#include <vector>

namespace { bool tracking=false;size_t allocations=0; }
void* operator new(std::size_t n){if(tracking)++allocations;if(void* p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept {std::free(p);}
void operator delete(void* p,std::size_t) noexcept {std::free(p);}
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete[](void* p) noexcept {std::free(p);}
void operator delete[](void* p,std::size_t) noexcept {std::free(p);}
namespace {
constexpr double pi=3.14159265358979323846;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
void convolution(){
  std::mt19937 random(731);std::uniform_real_distribution<float> noise(-.2f,.2f);
  for(int length:{1,127,128,129,1023,1024,1025,2049,4097,96000,384000}){
    std::vector<float> ir(length),input(8192),output(input.size());
    // Sparse long tails let the independent direct reference remain cheap.
    for(auto& x:input)x=noise(random);
    if(length<5000)for(auto& x:ir)x=noise(random);else{ir[0]=.7f;ir[1024]=-.2f;ir.back()=.1f;}
    bb::cabinet::Convolver convolver;convolver.init(ir);
    const size_t size=input.size()+ir.size()+256;std::vector<float> actual((size+127)/128*128),expected(actual.size());
    for(size_t k=0;k<ir.size();++k)if(ir[k]!=0)for(size_t n=0;n<input.size();++n)expected[n+k]+=input[n]*ir[k];
    std::copy(input.begin(),input.end(),actual.begin());tracking=true;
    for(size_t n=0;n<actual.size();n+=128)convolver.process(actual.data()+n);
    tracking=false;double error=0,energy=0;
    for(size_t n=0;n<actual.size();++n){error+=std::pow(actual[n]-expected[n],2);energy+=std::pow(expected[n],2);}
    require(std::sqrt(error/std::max(energy,1e-20))<3e-6,"Convolution differs from direct FIR / truncated tail");
  }
}
void resampling(){
  for(unsigned inputRate:{8000,44100,48000,96000,192000})for(unsigned outputRate:{8000,44100,48000,96000,192000}){
    std::vector<float> ir(1536);ir[0]=.3f;ir[100]=1;ir[500]=-.2f;ir.back()=.1f;
    auto out=bb::cabinet::resampleIr(ir,inputRate,outputRate);double sum=0;for(float x:out){require(std::isfinite(x),"IR resample finite");sum+=x;}
    require(std::abs(sum-1.2)<1e-5,"IR sample-rate conversion changed DC transfer gain");
    require(out.size()==size_t(std::ceil(ir.size()*double(outputRate)/inputRate)),"IR duration changed");
    ir.assign(1536,0);ir[300]=1;out=bb::cabinet::resampleIr(ir,inputRate,outputRate);
    auto peak=std::max_element(out.begin(),out.end())-out.begin();require(std::abs(double(peak)-300.*outputRate/inputRate)<=1,"IR alignment changed");
    ir[600]=-1;out=bb::cabinet::resampleIr(ir,inputRate,outputRate);sum=0;for(float x:out)sum+=x;require(std::abs(sum)<1e-5,"Zero-DC IR resampling changed polarity balance");
  }
}
void motor(){
  using K=bb::classic::CabinetKind;
  for(K kind:{K::Deluxe,K::Twin,K::Green412,K::T75412,K::AC30212,K::Recto412,K::PPC412})for(unsigned sr:{44100,48000,96000})for(double hz:{60,113,440,3000}){
    bb::ampcab::SpeakerPort p(sr,bb::ampcab::cabinetProfile(kind));std::complex<double> signal{};
    for(unsigned n=0;n<sr*2;++n){double phase=2*pi*hz*n/sr,v=std::cos(phase);p.predict();double i=p.current(v);p.commit(v);if(n>=sr)signal+=i*std::complex<double>(std::cos(phase),-std::sin(phase))*2./double(sr);}
    // Trapezoidal frequency warping, compared against independent continuous impedance.
    const auto reference=1./p.impedance(sr/pi*std::tan(pi*hz/sr));
    require(std::abs(signal-reference)/std::abs(reference)<2e-5,"Speaker impedance magnitude/phase mismatch");
    require(p.impedance(hz).real()>0,"Non-passive speaker load");
  }
}
void tubes(){
  double worst=0;for(double vp=10.37;vp<440;vp+=11.3)for(double vg=-8.47;vg<1;vg+=.13){
    double exact=bb::classic::triodeCurrent(vp,vg),approx=bb::ampcab::interpolatedTriodeCurrent(vp,vg);
    worst=std::max(worst,std::abs(exact-approx)/std::max(1e-5,exact));
  }std::printf("triode_max_relative_error=%.6g\n",worst);require(worst<.001,"Triode prepared surface error");
}
void models(){
  using A=bb::classic::AmpKind;using C=bb::classic::CabinetKind;
  double fingerprints[5]{};int index=0;
  for(A model:{A::Twin,A::JTM45,A::JCM800,A::AC30,A::Rectifier}){
    for(unsigned sr:{8000,44100,48000,96000,192000}){
      bb::classic::AmpControls control;control.enabled=true;control.kind=model;
      bb::ampcab::Head head(sr,control,C::Green412,170);
      tracking=true;
      for(unsigned n=0;n<sr/3;++n){if(n%1024==0){control.gain=(n/1024)%2?.95:.1;control.bass=1-control.gain;control.presence=control.gain;head.update(control);}
        float y=head.tick(float(.25*std::sin(n*.13)+.1*std::sin(n*.043)));require(std::isfinite(y)&&std::abs(y)<4,"Amp unstable");if(sr==48000)fingerprints[index]+=y*y;
      }
      for(unsigned n=0;n<sr;++n)require(std::isfinite(head.tick(0)),"Amp tail unstable");
      require(std::abs(head.tick(0))<1e-4,"Amp did not recover to silence");
      require(head.powerResidualVolts()<1e-5,"Power output/load solve residual");require(head.tubeResidualAmps()<1e-8,"Triode load/cathode solve residual");
      require(std::isfinite(head.tick(NAN))&&std::isfinite(head.tick(INFINITY)),"Amp nonfinite guard");tracking=false;
    }
    ++index;
  }
  for(int a=0;a<5;++a){require(fingerprints[a]>1e-4,"Silent amp model");for(int b=0;b<a;++b)require(std::abs(fingerprints[a]-fingerprints[b])>1e-3,"Indistinct amp models");}
  for(C model:{C::Deluxe,C::Twin,C::Green412,C::T75412,C::AC30212,C::Recto412,C::PPC412})for(unsigned sr:{8000,44100,48000,96000,192000}){
    bb::classic::CabinetControls control;control.enabled=true;control.kind=model;control.volumeLitres=bb::ampcab::cabinetProfile(model).litres;
    bb::ampcab::Cabinet cab(sr,control);double energy=0;tracking=true;
    for(unsigned n=0;n<sr;++n){float y=cab.tick(n==0?1.f:0.f);require(std::isfinite(y)&&std::abs(y)<4,"Cab unstable");energy+=y*y;}
    tracking=false;require(energy>1e-6,"Silent cabinet");require(std::abs(cab.tick(0))<1e-6,"Cab tail not stable");
  }
  bb::classic::AmpControls c;c.kind=A::JCM800;bb::ampcab::Head bypass(48000,c,C::Green412,170);
  for(int n=0;n<1000;++n)require(bypass.tick(n==0?.5f:0.f)==(n==32?.5f:0.f),"Amp bypass must retain exact latency");
  c.enabled=true;c.master=.8;bb::ampcab::Head reactive(48000,c,C::Green412,170);c.resistiveLoad=true;bb::ampcab::Head resistive(48000,c,C::Green412,170);double difference=0;
  for(int n=0;n<48000;++n){float x=float(.2*std::sin(2*pi*110*n/48000));difference+=std::abs(reactive.tick(x)-resistive.tick(x));}require(difference>.1,"Reactive load does not affect amp output");
  for(A model:{A::Twin,A::JTM45,A::AC30}){
    c.kind=model;c.gain=.8;c.master=.25;c.resistiveLoad=false;bb::ampcab::Head quiet(48000,c,C::Green412,170);c.master=.75;bb::ampcab::Head loud(48000,c,C::Green412,170);double error=0,energy=0;
    for(int n=0;n<12000;++n){float x=float(.2*std::sin(n*.06));double a=quiet.tick(x),b=loud.tick(x);error+=std::pow(3*a-b,2);energy+=b*b;}
    require(std::sqrt(error/energy)<1e-6,"Non-master amp LEVEL changed power-stage distortion");
  }
}
void benchmark(){
  using A=bb::classic::AmpKind;using C=bb::classic::CabinetKind;
  for(unsigned quality:{2u,4u})for(A kind:{A::Twin,A::JTM45,A::JCM800,A::AC30,A::Rectifier}){
    bb::classic::AmpControls c;c.enabled=true;c.kind=kind;c.oversampling=quality;
    bb::ampcab::Head left(48000,c,C::Green412,170),right(48000,c,C::Green412,170);
    auto start=std::chrono::steady_clock::now();double sum=0,energy=0;constexpr int frames=48000;
    for(int n=0;n<frames;++n){float x=float(.2*std::sin(n*.05));double y=left.tick(x);energy+=y*y;sum+=y+right.tick(x);}
    double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();std::printf("amp=%d oversampling=%u stereo_48k_realtime_cpu_percent=%.3f checksum=%.5f rms_dbfs=%.2f\n",int(kind),quality,ms/10,sum,10*std::log10(energy/frames));
  }
  std::vector<float> ir(96000);ir[0]=1;ir.back()=.1f;bb::cabinet::Convolver left,right;left.init(ir);right.init(ir);std::array<float,128>a{},b{};
  double worst=0;auto start=std::chrono::steady_clock::now();
  for(int n=0;n<3750;++n){a.fill(.01f);b.fill(-.01f);auto t=std::chrono::steady_clock::now();left.process(a.data());right.process(b.data());worst=std::max(worst,std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-t).count());}
  double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();std::printf("stereo_2s_ir_48k_cpu_percent=%.3f worst_128_frame_us=%.2f\n",ms/100,worst);
}
void chainLevels(){
  using A=bb::classic::AmpKind;using C=bb::classic::CabinetKind;
  for(const auto& pair:{std::pair{A::Twin,C::Twin},{A::JTM45,C::Green412},{A::JCM800,C::Green412},{A::AC30,C::AC30212},{A::Rectifier,C::Recto412}}){
    bb::classic::AmpControls ac;ac.kind=pair.first;ac.enabled=true;
    bb::classic::CabinetControls cc;cc.kind=pair.second;cc.enabled=true;cc.volumeLitres=bb::ampcab::cabinetProfile(cc.kind).litres;
    bb::ampcab::Head amp(48000,ac,cc.kind,cc.volumeLitres);bb::ampcab::Cabinet cab(48000,cc);double energy=0,peak=0;
    for(int n=0;n<48000;++n){double x=.12*std::sin(2*pi*110*n/48000)+.06*std::sin(2*pi*440*n/48000)+.02*std::sin(2*pi*1760*n/48000);double y=cab.tick(amp.tick(float(x)));if(n>=24000){energy+=y*y;peak=std::max(peak,std::abs(y));}}
    std::printf("matched_amp=%d default_chain_rms_dbfs=%.2f peak=%.6f\n",int(ac.kind),10*std::log10(energy/24000),peak);
    require(energy/24000>1e-4&&peak<1,"Default amp/cabinet chain level outside usable range");
  }
}
}
int main(){try{convolution();resampling();motor();tubes();models();chainLevels();require(allocations==0,"Audio callback heap allocation");benchmark();std::puts("amp_cab_tests=PASS callback_allocations=0");return 0;}catch(const std::exception& e){tracking=false;std::fprintf(stderr,"FAIL: %s\n",e.what());return 1;}}
