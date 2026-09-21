#include "effects.h"
#include "whitebox.h"
#include <NAM/get_dsp.h>
#include <NAM/slimmable.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <complex>
#include <vector>
namespace bb {
namespace {
constexpr int B=128, F=256;
constexpr double pi=3.14159265358979323846;
using C=std::complex<float>;
float gain(double db) { return std::pow(10., db/20.); }
void fft(std::array<C,F>& a, bool inverse) {
  for(int i=1,j=0;i<F;++i) { int bit=F>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit; if(i<j) std::swap(a[i],a[j]); }
  for(int len=2;len<=F;len<<=1) { C wlen=std::polar(1.f, float((inverse?2:-2)*pi/len)); for(int i=0;i<F;i+=len) { C w=1; for(int j=0;j<len/2;++j) { C u=a[i+j],v=a[i+j+len/2]*w; a[i+j]=u+v; a[i+j+len/2]=u-v; w*=wlen; } } }
  if(inverse) for(auto& v:a) v/=F;
}
struct Convolver {
  std::vector<std::array<C,F>> kernels, history;
  std::array<float,B> overlap{};
  size_t cursor=0;
  void init(const std::vector<float>& ir) {
    size_t count=(ir.size()+B-1)/B; kernels.resize(count); history.resize(count);
    for(size_t p=0;p<count;++p) { for(int i=0;i<B;++i) if(p*B+i<ir.size()) kernels[p][i]=ir[p*B+i]; fft(kernels[p],false); }
  }
  void process(float* data) {
    if(kernels.empty()) return;
    auto& h=history[cursor]; h.fill(0); for(int i=0;i<B;++i) h[i]=data[i]; fft(h,false);
    std::array<C,F> sum{};
    for(size_t p=0;p<kernels.size();++p) { auto& x=history[(cursor+history.size()-p)%history.size()]; for(int i=0;i<F;++i) sum[i]+=x[i]*kernels[p][i]; }
    fft(sum,true); for(int i=0;i<B;++i) { data[i]=sum[i].real()+overlap[i]; overlap[i]=sum[B+i].real(); }
    cursor=(cursor+1)%history.size();
  }
};
// Windowed-sinc streaming converter, fixed storage, 16-sample lookahead.
struct Resampler {
  std::array<float,4096> ring{}; long long total=0; double next=0, step=1, cutoff=1;
  void init(double in,double out) { step=in/out; cutoff=std::min(1.,out/in)*.94; }
  int push(const float* in,int n,float* out) {
    int count=0;
    for(int i=0;i<n;++i) { ring[total++%4096]=in[i]; while(next+16<total) { long long center=std::floor(next); double sum=0, norm=0;
      for(int k=-15;k<=16;++k) { double d=next-(center+k), x=d*cutoff; double w=(std::abs(x)<1e-8?1:std::sin(pi*x)/(pi*x))*cutoff*.5*(1+std::cos(pi*d/16)); long long index=center+k; norm+=w; if(index>=0 && index<total) sum+=ring[index%4096]*w; }
      out[count++]=float(sum/norm); next+=step;
    } }
    return count;
  }
};
struct Biquad {
  double b0=1,b1=0,b2=0,a1=0,a2=0,z1=0,z2=0;
  void set(double hz,double db,double rate,int kind=0) {
    hz=std::min(hz,rate*.45); double w=2*pi*hz/rate,c=std::cos(w),s=std::sin(w),a=s/(2*(kind? .70710678:1.414)),A=std::pow(10.,db/40),den=1+a/A;
    if(kind) { den=1+a; b0=(1+(kind==1?c:-c))/2; b1=(kind==1?-(1+c):(1-c)); b2=b0; a1=-2*c; a2=1-a; }
    else { b0=1+a*A;b1=-2*c;b2=1-a*A;a1=-2*c;a2=1-a/A; }
    b0/=den;b1/=den;b2/=den;a1/=den;a2/=den;
  }
  float tick(float x) { double y=b0*x+z1;z1=b1*x-a1*y+z2;z2=b2*x-a2*y;return float(y); }
};
struct DelayLine {
  std::vector<float> data; size_t pos=0;
  void init(size_t n) { data.assign(n,0); }
  float read(double frames) const { frames=std::clamp(frames,1.,double(data.size()-2)); double p=pos+data.size()-frames;size_t i=size_t(p)%data.size();double f=p-std::floor(p);return float(data[i]*(1-f)+data[(i+1)%data.size()]*f); }
  void push(float x) { data[pos]=x;pos=(pos+1)%data.size(); }
};
struct Params { whitebox::Controls drive; float in=1,out=1,eqGain=1,cabGain=1,delayMs=350,feedback=.3,mix=.2,tone=6000,decay=2.5,pre=20,damping=.5,revMix=.2;bool amp=false,cab=false,eq=false,delay=false,reverb=false; std::array<float,7> bands{};float low=20,high=20000; };
Params parse(const nlohmann::json& j) {
  Params p;
  if(j.contains("drive")) {
    const auto& d=j.at("drive"); const auto device=d.at("device").get<std::string>();
    if(device!="ts808" && device!="sd1" && device!="rat") throw std::runtime_error("WHITEBOX_UNKNOWN_DEVICE");
    if(d.at("revision").get<int>()!=1) throw std::runtime_error("WHITEBOX_UNSUPPORTED_REVISION");
    p.drive.device=device=="ts808"?whitebox::Device::TS808:device=="sd1"?whitebox::Device::SD1:whitebox::Device::RAT;
    p.drive.enabled=d.at("enabled");p.drive.drive=d.at("drive");p.drive.tone=d.at("tone");p.drive.level=d.at("level");p.drive.inputVolts=d.at("inputVolts");p.drive.oversampling=d.at("oversampling");
    for(double value:{p.drive.drive,p.drive.tone,p.drive.level}) if(!std::isfinite(value)||value<0||value>1) throw std::runtime_error("WHITEBOX_INVALID_CONTROL");
    if(!std::isfinite(p.drive.inputVolts)||p.drive.inputVolts<.1||p.drive.inputVolts>10||(p.drive.oversampling!=2&&p.drive.oversampling!=4)) throw std::runtime_error("WHITEBOX_INVALID_CALIBRATION_OR_QUALITY");
  }
  p.in=gain(j.at("inputGainDb"));p.out=gain(j.at("outputGainDb"));p.amp=j["amp"]["enabled"];p.cab=j["cab"]["enabled"];p.cabGain=gain(j["cab"]["gainDb"]);p.low=j["cab"]["lowCut"];p.high=j["cab"]["highCut"];p.eq=j["eq"]["enabled"];p.eqGain=gain(j["eq"]["gainDb"]);p.bands=j["eq"]["bands"].get<std::array<float,7>>();auto d=j["delay"];p.delay=d["enabled"];p.delayMs=d["timeMs"];if(d["sync"].get<bool>()) {std::string div=d["division"];p.delayMs=float(std::clamp(60000.0/d["bpm"].get<double>()*(div=="1/4"?1.0:div=="1/8d"?.75:div=="1/8"?.5:.25),1.0,2000.0));}p.feedback=d["feedback"];p.mix=d["mix"];p.tone=d["tone"];auto r=j["reverb"];p.reverb=r["enabled"];p.decay=r["decay"];p.pre=r["preDelayMs"];p.damping=r["damping"];p.revMix=r["mix"];return p;
}
}
struct Effects::Impl {
  unsigned rate; Params target,current; std::array<Params,64> updates{}; std::atomic<unsigned> updateWrite{0},updateRead{0}; std::array<int,5> order{};
  std::unique_ptr<whitebox::Drive> drives[2];
  std::unique_ptr<nam::DSP> models[2]; Resampler up[2],down[2]; bool convert=false;
  std::array<float,4096> modelIn[2],modelOut[2],converted[2],fifo[2]; size_t write[2]{},read[2]{};
  Convolver cab[2]; Biquad eq[2][7],cut[2][2]; DelayLine delay[2],pre[2],comb[2][8]; float damp[2][8]{},delayTone[2]{};
  std::array<float,B> input[2]{},output[2]{}; unsigned index=0; float fade=0;
  Impl(const nlohmann::json& prepared,unsigned sr):rate(sr) {
    const auto& chain=prepared.at("chain"); target=current=parse(chain);
    current.mix=target.delay?target.mix:0;current.revMix=target.reverb?target.revMix:0;
    std::vector<std::string> blocks=chain.at("order").get<std::vector<std::string>>();
    if(blocks.size()==4 && std::find(blocks.begin(),blocks.end(),"drive")==blocks.end()) blocks.insert(blocks.begin(),"drive");
    if(blocks.size()!=5) throw std::runtime_error("INVALID_EFFECT_ORDER");
    std::array<bool,5> seen{};int i=0;
    for(const auto& v:blocks) {int id=v=="amp"?0:v=="eq"?1:v=="delay"?2:v=="reverb"?3:v=="drive"?4:-1;if(id<0||seen[id]) throw std::runtime_error("INVALID_EFFECT_ORDER");seen[id]=true;order[i++]=id;}
    for(auto& drive:drives) drive=std::make_unique<whitebox::Drive>(sr,target.drive);
    double modelRate=prepared.value("modelRate",double(sr));if(modelRate<=0) modelRate=sr;
    convert=!prepared["model"].is_null() && modelRate!=sr;
    if(!prepared["model"].is_null()) {auto model=nlohmann::json::parse(prepared["model"].get<std::string>()); for(int c=0;c<2;++c) {models[c]=nam::get_dsp(model);if(models[c]->NumInputChannels()!=1 || models[c]->NumOutputChannels()!=1) throw std::runtime_error("NAM_REQUIRES_MONO_MODEL");if(auto* slim=dynamic_cast<nam::SlimmableModel*>(models[c].get())) slim->SetSlimmableSize(chain["amp"]["quality"]=="lite"?0:1);models[c]->Reset(modelRate,4096);up[c].init(sr,modelRate);down[c].init(modelRate,sr); if(convert) write[c]=64;}}
    for(int c=0;c<2;++c) {
      delay[c].init(sr*2+4);pre[c].init(sr/5+4);
      for(int k=0;k<8;++k) comb[c][k].init(size_t(sr*(.0297+.0041*k+.00071*c))+3);
      if(!prepared["ir"].is_null()) {auto ir=prepared["ir"][std::min(c,int(prepared["ir"].size())-1)].get<std::vector<float>>();double irRate=prepared["irRate"];if(irRate!=sr) {Resampler r;r.init(irRate,sr);std::vector<float> res;res.reserve(size_t(ir.size()*sr/irRate)+64);std::array<float,4096> temp{};for(size_t p=0;p<ir.size();p+=B) {int n=r.push(ir.data()+p,std::min(size_t(B),ir.size()-p),temp.data());res.insert(res.end(),temp.begin(),temp.begin()+n);}std::array<float,32> zeros{};int n=r.push(zeros.data(),32,temp.data());res.insert(res.end(),temp.begin(),temp.begin()+n);ir=std::move(res);}cab[c].init(ir); }
    }
  }
  void block() {
    auto r=updateRead.load();const auto w=updateWrite.load(std::memory_order_acquire);while(r!=w) {target=updates[r%64];++r;}updateRead.store(r,std::memory_order_release);
    current.in+=(target.in-current.in)*.3f;current.out+=(target.out-current.out)*.3f;
    for(int c=0;c<2;++c) for(int i=0;i<B;++i) output[c][i]=input[c][i]*current.in;
    for(int effect:order) {
      if(effect==4) {
        for(int c=0;c<2;++c) {drives[c]->update(target.drive);for(auto& x:output[c]) x=drives[c]->tick(x);}
      } else if(effect==0) {
        if(target.amp) for(int c=0;c<2;++c) if(models[c]) {
          if(convert) {int n=up[c].push(output[c].data(),B,modelIn[c].data());float* in=modelIn[c].data();float* out=modelOut[c].data();if(n) models[c]->process(&in,&out,n);int m=down[c].push(out,n,converted[c].data());for(int k=0;k<m;++k) fifo[c][write[c]++%4096]=converted[c][k];for(int k=0;k<B;++k) output[c][k]=read[c]<write[c]?fifo[c][read[c]++%4096]:0;}
          else {float* in=output[c].data();float* out=modelOut[c].data();models[c]->process(&in,&out,B);std::copy_n(out,B,output[c].data());}
        }
        if(target.cab) for(int c=0;c<2;++c) {cab[c].process(output[c].data());cut[c][0].set(target.low,0,rate,1);cut[c][1].set(target.high,0,rate,2);for(auto& x:output[c]) x=cut[c][1].tick(cut[c][0].tick(x))*target.cabGain;}
      } else if(effect==1 && target.eq) {
        for(int k=0;k<7;++k) {current.bands[k]+=(target.bands[k]-current.bands[k])*.2f;for(int c=0;c<2;++c) eq[c][k].set(100*(1<<k),current.bands[k],rate);}
        for(int c=0;c<2;++c) for(auto& x:output[c]) {for(auto& filter:eq[c]) x=filter.tick(x);x*=target.eqGain;}
      } else if(effect==2) {
        for(int i=0;i<B;++i) {current.delayMs+=(target.delayMs-current.delayMs)*.001f;current.mix+=((target.delay?target.mix:0)-current.mix)*.002f;current.feedback+=(target.feedback-current.feedback)*.002f;
          for(int c=0;c<2;++c) {float x=output[c][i],wet=delay[c].read(current.delayMs*rate/1000);delayTone[c]+=(wet-delayTone[c])*float(1-std::exp(-2*pi*target.tone/rate));delay[c].push(x+delayTone[c]*current.feedback);output[c][i]=x*(1-current.mix)+wet*current.mix;}
        }
      } else if(effect==3) {
        for(int i=0;i<B;++i) {current.revMix+=((target.reverb?target.revMix:0)-current.revMix)*.002f;
          for(int c=0;c<2;++c) {float x=output[c][i];float v=target.pre<.01?x:pre[c].read(target.pre*rate/1000);pre[c].push(x);float wet=0;for(int k=0;k<8;++k) {auto& d=comb[c][k];float y=d.read(d.data.size()-2);damp[c][k]+=(y-damp[c][k])*(1-target.damping*.92f);float fb=std::pow(.001f,float(d.data.size())/(rate*target.decay));d.push(v*.18f+damp[c][k]*fb);wet+=y*.3f;}output[c][i]=x*(1-current.revMix)+wet*current.revMix;}
        }
      }
    }
    for(int i=0;i<B;++i) {fade=std::min(1.f,fade+1.f/(rate*.01f));for(int c=0;c<2;++c) {float x=output[c][i]*current.out*fade;output[c][i]=std::isfinite(x)?x:0;}}
  }
};
Effects::Effects(const nlohmann::json& p,unsigned r):impl(std::make_unique<Impl>(p,r)) {}
Effects::~Effects()=default;
void Effects::update(const nlohmann::json& j) {auto p=parse(j);if(p.drive.device!=impl->current.drive.device||p.drive.oversampling!=impl->current.drive.oversampling) throw std::runtime_error("WHITEBOX_REBUILD_REQUIRED");auto w=impl->updateWrite.load();if(w-impl->updateRead.load(std::memory_order_acquire)>=64) return;impl->updates[w%64]=p;impl->updateWrite.store(w+1,std::memory_order_release);}
unsigned Effects::latency() const {return B+whitebox::Drive::latencyFrames+(impl->convert?64:0);}
void Effects::process(const float* in,float* out,unsigned frames,unsigned channels) {
  for(unsigned i=0;i<frames;++i) {for(int c=0;c<2;++c) {impl->input[c][impl->index]=in?in[i*channels+std::min(unsigned(c),channels-1)]:0;out[i*2+c]=impl->output[c][impl->index];} if(++impl->index==B) {impl->block();impl->index=0;} }
}
}
