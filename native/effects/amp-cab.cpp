#include "amp-cab.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace bb::ampcab {
namespace {
constexpr double pi=3.14159265358979323846;
double pot(double x) { return (std::pow(10.,2*x)-1)/99; }
template<size_t N> using Matrix=std::array<std::array<double,N>,N>;
template<size_t N> Matrix<N> inverse(Matrix<N> a) {
  Matrix<N> b{}; for(size_t i=0;i<N;++i)b[i][i]=1;
  for(size_t i=0;i<N;++i){size_t p=i;for(size_t j=i+1;j<N;++j)if(std::abs(a[j][i])>std::abs(a[p][i]))p=j;
    if(std::abs(a[p][i])<1e-24)throw std::runtime_error("AMP_CAB_SINGULAR");
    std::swap(a[i],a[p]);std::swap(b[i],b[p]);double d=a[i][i];
    for(size_t j=0;j<N;++j){a[i][j]/=d;b[i][j]/=d;}
    for(size_t k=0;k<N;++k)if(k!=i){double m=a[k][i];for(size_t j=0;j<N;++j){a[k][j]-=m*a[i][j];b[k][j]-=m*b[i][j];}}
  }return b;
}
struct Filter {
  double b0=1,b1=0,b2=0,a1=0,a2=0,z1=0,z2=0;
  void set(double sr,double hz,double db,double q,bool lowpass=false){
    double w=2*pi*std::min(hz,.45*sr)/sr,c=std::cos(w),alpha=std::sin(w)/(2*q),A=std::pow(10.,db/40),d=1+alpha/A;
    if(lowpass){d=1+alpha;b0=(1-c)/2;b1=1-c;b2=b0;a1=-2*c;a2=1-alpha;}
    else{b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a1=-2*c;a2=1-alpha/A;}
    b0/=d;b1/=d;b2/=d;a1/=d;a2/=d;
  }
  double tick(double x){double y=b0*x+z1;z1=b1*x-a1*y+z2;z2=b2*x-a2*y;return y;}
};
// Static current surface derived from this repository's Koren equation, not
// recorded audio. Built once on the control thread, shared read-only by voices.
struct TriodeSurface {
  // Two compact scalar tables replace exp/log/pow without coarsely sampling
  // the steep low-plate-voltage 2D current surface. Nonuniform power knots
  // resolve cutoff; plate and grid dependence remains analytic.
  std::array<double,8193> soft{};
  std::array<double,4097> power{};
  struct Value { double current, plateDerivative, gridDerivative; };
  TriodeSurface(){
    for(size_t i=0;i<soft.size();++i){double x=double(i)/128-32;soft[i]=std::max(0.,x)+std::log1p(std::exp(-std::abs(x)));}
    for(size_t i=0;i<power.size();++i)power[i]=2*std::pow(std::pow(double(i)/512,2),1.4)/1060;
  }
  Value read(double vp,double vg) const {
    if(vp<=0)return {};
    const double den=std::sqrt(300+vp*vp),q=600*(.01+vg/den);
    if(q<=-32)return {};
    double sp=q,slope=1;
    if(q<32){double at=(q+32)*128;size_t i=size_t(at);slope=(soft[i+1]-soft[i])*128;sp=soft[i]+(soft[i+1]-soft[i])*(at-i);}
    double e=std::clamp(vp*sp/600,0.,63.999999),at=std::sqrt(e)*512;size_t i=size_t(at);
    double lo=double(i)*i/(512.*512),hi=double(i+1)*(i+1)/(512.*512),derivative=(power[i+1]-power[i])/(hi-lo);
    double current=power[i]+(e-lo)*derivative;
    return {current,derivative*(sp/600-vp*vp*vg*slope/(den*den*den)),derivative*vp*slope/den};
  }
};
const TriodeSurface& surface(){static const TriodeSurface table;return table;}
struct Tube {
  const TriodeSurface* table=nullptr;
  double rp=100000,rk=1500,gc=0,gk=1/1500.,supply=300,dc=0,history=0,previous=0,worstResidual=0;
  void init(double sr,double plateR,double cathodeR,double cathodeC,double volts){
    table=&surface();rp=plateR;rk=cathodeR;gc=2*sr*cathodeC;gk=1/rk+gc;supply=volts;
    double lo=0,hi=supply/(rp+rk);
    for(int n=0;n<60;++n){double i=(lo+hi)*.5;if(i>table->read(supply-(rp+rk)*i,-rk*i).current)hi=i;else lo=i;}
    previous=(lo+hi)*.5;dc=supply-rp*previous;history=rk*previous;
  }
  double tick(double grid){
    grid=std::clamp(grid,-60.,12.); // declared operating envelope; no grid-current claim
    const double offset=gc*history/gk,r=rp+1/gk;
    double lo=0,hi=std::max(0.,(supply-offset)/r),i=std::clamp(previous,lo,hi);
    bool converged=false;double residual=0;
    for(int n=0;n<10;++n){auto v=table->read(supply-offset-r*i,grid-offset-i/gk);double f=i-v.current;
      if(std::abs(f)<1e-10){residual=std::abs(f);converged=true;break;}if(f>0)hi=i;else lo=i;
      double next=i-f/(1+v.plateDerivative*r+v.gridDerivative/gk);i=next>lo&&next<hi?next:(lo+hi)*.5;
    }
    if(!converged){for(int n=0;n<24;++n){i=(lo+hi)*.5;double f=i-table->read(supply-offset-r*i,grid-offset-i/gk).current;residual=std::abs(f);if(residual<1e-10)break;if(f>0)hi=i;else lo=i;}}
    worstResidual=std::max(worstResidual,residual);
    previous=i;const double vk=offset+i/gk;if(gc>0)history=2*vk-history;
    return supply-rp*i-dc;
  }
};
// FMV and Top Boost are different node connections. Pots interact through the
// passive network. Constant source/load impedances are explicit reductions.
struct Stack {
  Matrix<5> inv{};std::array<double,3> h{},g{};double slope=0;bool vox=false;
  void configure(double rate,classic::AmpKind kind,double bass,double mid,double treble){
    vox=kind==classic::AmpKind::AC30;bool twin=kind==classic::AmpKind::Twin,jtm=kind==classic::AmpKind::JTM45,mesa=kind==classic::AmpKind::Rectifier;
    g={2*rate*(vox?50e-12:twin||jtm?250e-12:mesa?680e-12:470e-12),2*rate*(twin?100e-9:22e-9),2*rate*(twin?47e-9:22e-9)};
    slope=1/(vox||twin?100000.:jtm?56000.:mesa?47000.:33000.);Matrix<5>a{};
    auto stamp=[&](int x,int y,double v){a[x][x]+=v;if(y>=0){a[y][y]+=v;a[x][y]-=v;a[y][x]-=v;}};
    a[0][0]+=slope;a[1][1]+=g[0];stamp(0,2,g[1]);stamp(0,3,g[2]);
    stamp(2,3,1/(1+(twin?250000.:1e6)*pot(bass)));stamp(3,-1,1/(vox?10000.:1+(twin?10000.:25000.)*mid));
    const double t=vox?pot(treble):treble,rt=vox?1e6:250000.;
    stamp(1,4,1/(1+rt*(1-t)));stamp(4,vox?2:3,1/(1+rt*t));stamp(4,-1,1/1e6);inv=inverse(a);
  }
  double tick(double x){std::array<double,5>b={slope*x+g[1]*h[1]+g[2]*h[2],g[0]*(x-h[0]),-g[1]*h[1],-g[2]*h[2],0},v{};
    for(int i=0;i<5;++i)for(int j=0;j<5;++j)v[i]+=inv[i][j]*b[j];
    h[0]=2*(x-v[1])-h[0];h[1]=2*(v[0]-v[2])-h[1];h[2]=2*(v[0]-v[3])-h[2];return v[4];}
};
double hp(whitebox::Lowpass& state,double x,double rate,double r,double c){return x-state.tick(x,1/(2*rate*r*c));}
}

classic::AmpKind ampKind(std::string_view id){
  using K=classic::AmpKind;
  if(id=="fender-twin")return K::Twin;if(id=="marshall-jtm45")return K::JTM45;if(id=="marshall-jcm800")return K::JCM800;if(id=="vox-ac30")return K::AC30;if(id=="mesa-rectifier")return K::Rectifier;
  if(id=="ab763-pre")return K::AB763;if(id=="2203-pre")return K::Lead2203;if(id=="orange")return K::Orange;if(id=="mesa")return K::Mesa;if(id=="vox")return K::Vox;
  throw std::runtime_error("UNKNOWN_CLASSIC_AMP");
}
classic::CabinetKind cabKind(std::string_view id){
  using K=classic::CabinetKind;
  if(id=="fender-deluxe")return K::Deluxe;if(id=="fender-twin")return K::Twin;if(id=="marshall-1960ax")return K::Green412;if(id=="marshall-1960b")return K::T75412;if(id=="vox-ac30c2")return K::AC30212;if(id=="mesa-rectifier")return K::Recto412;if(id=="orange-ppc412")return K::PPC412;
  if(id=="open112")return K::Open112;if(id=="open212")return K::Open212;if(id=="sealed412")return K::Sealed412;
  throw std::runtime_error("UNKNOWN_PHYSICAL_CAB");
}
bool modeled(classic::AmpKind k){return k>=classic::AmpKind::Twin;}
bool modeled(classic::CabinetKind k){return k>=classic::CabinetKind::Deluxe;}
CabinetProfile cabinetProfile(classic::CabinetKind kind){
  // Breakup fit parameters adapted from GainStageFx (MIT), see bundled notice.
  // Celestion mass, Bl, Qms and coil values are estimates, not factory T/S.
  Speaker c12n{6.05,.0009,.0299,.000066,10.46,7.52,.04909,{{{1108,8.94,1.81},{2092,12,2.12},{3497,10.45,1.27}}},5829,2.13};
  Speaker green{6.7,.0009,.028,1/(std::pow(2*pi*75,2)*.028),9.902,9.73,.04909,{{{986,4.51,2.52},{2489,12,1.22},{3811,12,2.42}}},5478,.5};
  Speaker v30{7.3,.0009,.028,green.compliance,14.706,9.73,.04909,{{{897,4.17,1.94},{2454,10.62,1.26},{3871,11.82,2.44}}},5128,.5};
  Speaker t75{6.77,.0009,.028,1/(std::pow(2*pi*85,2)*.028),10.874,9.73,.04909,{{{1266,-5.07,3.53},{2205,12,.99},{3510,9.25,1.45}}},7263,.5};
  using K=classic::CabinetKind;
  switch(kind){case K::Green412:return {green,2,2,true,170};case K::T75412:return {t75,2,2,true,180};case K::AC30212:return {green,2,1,false,65};case K::Recto412:return {v30,2,2,true,200};case K::PPC412:return {v30,2,2,true,150};case K::Twin:case K::Open212:return {c12n,1,2,false,70};case K::Sealed412:return {c12n,2,2,true,80};default:return {c12n,1,1,false,40};}
}
SpeakerPort::SpeakerPort(double sr,CabinetProfile p):profile(p){
  const auto& s=p.speaker;const double rm=std::sqrt(s.mass/s.compliance)/s.qms;
  const double stiffness=1/s.compliance+(p.sealed?1.204*343*343*s.area*s.area*p.series*p.parallel/(p.litres*.001):0);
  Matrix<3>a={{{-s.re/s.le,-s.bl/s.le,0},{s.bl/s.mass,-rm/s.mass,-stiffness/s.mass},{0,1,0}}},left{},right{};double h=.5/sr;
  for(int i=0;i<3;++i)for(int j=0;j<3;++j){left[i][j]=(i==j?1:0)-h*a[i][j];right[i][j]=(i==j?1:0)+h*a[i][j];}
  auto inv=inverse(left);
  for(int i=0;i<3;++i){excitation[i]=inv[i][0]*h/s.le;for(int j=0;j<3;++j)for(int k=0;k<3;++k)transition[i][j]+=inv[i][k]*right[k][j];}
}
void SpeakerPort::predict(){for(int i=0;i<3;++i){base[i]=excitation[i]*previousInput;for(int j=0;j<3;++j)base[i]+=transition[i][j]*state[j];}}
double SpeakerPort::admittance()const{return excitation[0]*profile.parallel/profile.series;}
double SpeakerPort::historyCurrent()const{return base[0]*profile.parallel;}
double SpeakerPort::current(double v)const{return admittance()*v+historyCurrent();}
double SpeakerPort::commit(double v){previousInput=v/profile.series;for(int i=0;i<3;++i)state[i]=base[i]+excitation[i]*previousInput;return state[1];}
std::complex<double> SpeakerPort::impedance(double hz)const{
  const auto& s=profile.speaker;std::complex<double> jw(0,2*pi*hz);
  double k=1/s.compliance+(profile.sealed?1.204*343*343*s.area*s.area*profile.series*profile.parallel/(profile.litres*.001):0);
  return (s.re+jw*s.le+s.bl*s.bl/(std::sqrt(s.mass/s.compliance)/s.qms+jw*s.mass+k/jw))*double(profile.series)/double(profile.parallel);
}
double interpolatedTriodeCurrent(double vp,double vg){return surface().read(vp,vg).current;}

struct Head::Impl {
  classic::AmpControls target,current;unsigned factor,taps;double rate,smooth,wet;
  Tube tubes[4];Stack stack;SpeakerPort load;
  whitebox::Lowpass coupling[5],miller[4],bright,feedback,transformer,cutFilter,dc;
  std::array<double,129> kernel{},down{};std::array<double,33> up{};std::array<float,32> dry{};
  unsigned upPos=0,downPos=0,dryPos=0,clock=0;double gain=0,master=0,voltage=0,supplyDrop=0,feedbackState=0,worstPowerResidual=0;
  Impl(unsigned sr,const classic::AmpControls& c,classic::CabinetKind cabinet,double litres):target(c),current(c),factor(c.oversampling),taps(32*factor+1),rate(sr*double(factor)),smooth(1-std::exp(-1/(.01*sr))),wet(c.enabled?1:0),load(rate,[&]{auto p=cabinetProfile(cabinet);if(litres>0)p.litres=litres;return p;}()){
    using K=classic::AmpKind;
    for(auto& t:tubes)t.init(rate,100000,1500,25e-6,300);
    if(c.kind==K::JCM800){tubes[0].init(rate,100000,2700,.68e-6,300);tubes[1].init(rate,100000,10000,0,300);tubes[2].init(rate,100000,820,.68e-6,300);}
    if(c.kind==K::JTM45){tubes[0].init(rate,100000,820,250e-6,300);tubes[1].init(rate,100000,820,.68e-6,300);}
    if(c.kind==K::AC30){tubes[0].init(rate,220000,1500,2.5e-6,280);tubes[1].init(rate,100000,1500,0,280);}
    if(c.kind==K::Rectifier){tubes[0].init(rate,220000,1800,1e-6,350);tubes[1].init(rate,100000,1800,1e-6,400);tubes[2].init(rate,100000,39000,0,415);tubes[3].init(rate,220000,1800,1e-6,415);}
    controls();double sum=0,cutoff=.9/factor;for(unsigned i=0;i<taps;++i){double d=double(i)-(taps-1)*.5;kernel[i]=(d==0?cutoff:std::sin(pi*cutoff*d)/(pi*d))*(.42-.5*std::cos(2*pi*i/(taps-1))+.08*std::cos(4*pi*i/(taps-1)));sum+=kernel[i];}for(auto& k:kernel)k/=sum;
  }
  void controls(){gain=pot(current.gain);master=pot(current.master);stack.configure(rate,current.kind,current.bass,current.middle,current.treble);}
  double power(double x){
    using K=classic::AmpKind;const bool vox=current.kind==K::AC30,rect=current.kind==K::Rectifier;
    // Reduced push-pull transfer: opposed 3/2-law branches, finite rails,
    // output resistance, implicit frequency-dependent feedback and speaker port.
    // Tube-specific bias/drive/OT values below are nominal engineering estimates.
    const double bias=vox?.65:current.kind==K::JTM45?.35:.18;
    const double rail=(vox?22.:current.kind==K::JTM45?30.:40.)*(1-.4*current.sag*supplyDrop);
    const double resistance=vox?5.:rect?4.:2.;
    const double beta=vox||rect?0:current.kind==K::Twin?.045:.025;
    const double hi=beta*(1-.85*current.presence),lp=1/(1+rate/(2*pi*650)),fbSlope=hi+(beta-hi)*lp,fbOffset=(beta-hi)*feedbackState*(1-lp);
    const double y=current.resistiveLoad?.125:(load.predict(),load.admittance()),history=current.resistiveLoad?0:load.historyCurrent();
    // The source is rail-limited, but a reactive load's back EMF can move the
    // terminal voltage beyond that rail. Bracket the actual port equation.
    const double portSlope=1+resistance*y;
    double lo=(-rail-resistance*history)/portSlope,high=(rail-resistance*history)/portSlope,v=std::clamp(voltage,lo,high);
    bool converged=false;double residual=0;
    for(int n=0;n<8;++n){double u=x-fbSlope*v-fbOffset,a=std::max(0.,bias+u),b=std::max(0.,bias-u),q=(a*std::sqrt(a)-b*std::sqrt(b))/(3*std::sqrt(bias)),dq=(std::sqrt(a)+std::sqrt(b))/(2*std::sqrt(bias));
      double z=1+q*q,source=rail*q/std::sqrt(z),derivative=rail*dq/(z*std::sqrt(z));
      double f=v+resistance*(y*v+history)-source;if(std::abs(f)<1e-8){converged=true;residual=std::abs(f);break;}if(f>0)high=v;else lo=v;
      double next=v-f/(1+resistance*y+derivative*fbSlope);v=next>lo&&next<high?next:(lo+high)*.5;
    }
    if(!converged){for(int n=0;n<32;++n){v=(lo+high)*.5;double u=x-fbSlope*v-fbOffset,a=std::max(0.,bias+u),b=std::max(0.,bias-u),q=(a*std::sqrt(a)-b*std::sqrt(b))/(3*std::sqrt(bias));double f=v+resistance*(y*v+history)-rail*q/std::sqrt(1+q*q);residual=std::abs(f);if(residual<1e-8)break;if(f>0)high=v;else lo=v;}}
    worstPowerResidual=std::max(worstPowerResidual,residual);
    voltage=v;feedbackState+=lp*(v-feedbackState);const double i=y*v+history;
    if(!current.resistiveLoad)load.commit(v);
    supplyDrop+=(std::min(1.,std::abs(i)*.45)-supplyDrop)/(rate*(vox?.08:.12));
    return hp(transformer,v,rate,1,1/(2*pi*25))/32;
  }
  double circuit(double x){
    using K=classic::AmpKind;const auto k=current.kind;
    x=hp(coupling[0],x,rate,1e6,22e-9);x=tubes[0].tick(miller[0].tick(x,1/(2*rate*34000*120e-12)));
    if(k==K::Twin)x=stack.tick(x);
    double coupled=hp(coupling[1],x,rate,k==K::AC30?500000:1e6,k==K::AC30?47e-9:22e-9);
    const double brightC=k==K::Rectifier?1e-9:k==K::JCM800?1e-9:k==K::JTM45?100e-12:k==K::AC30?100e-12:0;
    x=coupled*gain;if(brightC>0)x+=(1-gain)*hp(bright,coupled,rate,std::max(1.,1000000*gain*(1-gain)),brightC);
    x=tubes[1].tick(miller[1].tick(x,1/(2*rate*100000*120e-12)));
    if(k==K::JCM800||k==K::Rectifier){x=hp(coupling[2],x,rate,470000,22e-9)*.5;x=tubes[2].tick(miller[2].tick(x,1/(2*rate*100000*(k==K::Rectifier?1000e-12:120e-12))));}
    if(k==K::Rectifier){x=hp(coupling[4],x,rate,330000,22e-9)*.6;x=tubes[3].tick(miller[3].tick(x,1/(2*rate*100000*120e-12)));}
    if(k!=K::Twin)x=stack.tick(x); // ideal cathode-follower reduction
    // Original non-master circuits run directly into the phase-inverter/power
    // reduction. Their extra software LEVEL belongs after the power stage.
    const bool nonMaster=k==K::Twin||k==K::JTM45||k==K::AC30;
    x=hp(coupling[3],x,rate,1e6,47e-9)*(nonMaster?.3:master*.12);
    if(k==K::AC30||k==K::Rectifier){double r=k==K::AC30?250000*(1-pot(current.cut))+100:22000+25000*current.presence,c=k==K::AC30?4.7e-9:3e-9,source=k==K::AC30?50000:40000;x-=hp(cutFilter,x,rate,r+source,c)*source/(r+source);}
    return power(x)*(nonMaster?current.master:1);
  }
  float tick(float input){double safe=std::isfinite(input)?std::clamp(double(input),-20.,20.):0;
    auto approach=[&](double& v,double t){v+=(t-v)*smooth;};
    approach(current.gain,target.gain);approach(current.bass,target.bass);approach(current.middle,target.middle);approach(current.treble,target.treble);approach(current.master,target.master);approach(current.presence,target.presence);approach(current.cut,target.cut);approach(current.sag,target.sag);approach(current.inputVolts,target.inputVolts);approach(wet,target.enabled?1:0);
    if(++clock==32){clock=0;controls();}
    double dryValue=dry[dryPos];dry[dryPos]=float(safe);dryPos=(dryPos+1)%32;up[upPos]=safe*current.inputVolts;double result=0;
    for(unsigned phase=0;phase<factor;++phase){double x=0;for(unsigned k=phase,age=0;k<taps;k+=factor,++age)x+=kernel[k]*up[(upPos+33-age)%33]*factor;down[downPos]=circuit(x);if(phase==0)for(unsigned k=0;k<taps;++k)result+=kernel[k]*down[(downPos+taps-k)%taps];downPos=(downPos+1)%taps;}
    upPos=(upPos+1)%33;if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
    return float(dryValue*(1-wet)+result*wet/current.inputVolts);
  }
};
Head::Head(unsigned r,const classic::AmpControls& c,classic::CabinetKind load,double litres):impl(std::make_unique<Impl>(r,c,load,litres)){}
Head::~Head()=default;
void Head::update(const classic::AmpControls& c){if(c.kind!=impl->target.kind||c.oversampling!=impl->target.oversampling||c.resistiveLoad!=impl->target.resistiveLoad)throw std::runtime_error("AMP_REBUILD_REQUIRED");impl->target=c;}
float Head::tick(float x){return impl->tick(x);}
double Head::powerResidualVolts()const{return impl->worstPowerResidual;}
double Head::tubeResidualAmps()const{double r=0;for(const auto& t:impl->tubes)r=std::max(r,t.worstResidual);return r;}

struct Cabinet::Impl {
  double rate,smooth,wet,velocity=0,volume;classic::CabinetControls target,current;SpeakerPort port;
  Filter breakup[3],rolloff;whitebox::Lowpass dipole,aperture[2];unsigned clock=0;
  Impl(unsigned sr,const classic::CabinetControls& c):rate(sr),smooth(1-std::exp(-1/(.02*sr))),wet(c.enabled?1:0),volume(c.volumeLitres),target(c),current(c),port(sr,[&]{auto p=cabinetProfile(c.kind);p.litres=c.volumeLitres;return p;}()){
    auto s=port.parameters().speaker;for(int i=0;i<3;++i)breakup[i].set(sr,s.peaks[i][0],s.peaks[i][1],s.peaks[i][2]);rolloff.set(sr,s.rolloff,0,s.rolloffQ,true);
  }
  float tick(float input){double x=std::isfinite(input)?input:0;
    current.distanceMetres+=(target.distanceMetres-current.distanceMetres)*smooth;current.micAngle+=(target.micAngle-current.micAngle)*smooth;wet+=((target.enabled?1:0)-wet)*smooth;
    // Enclosure volume is a structural parameter in new models; preparation
    // supplies a fresh load off-thread. No state reset or matrix inversion here.
    port.predict();double v=port.commit(x),acceleration=(v-velocity)*rate;velocity=v;
    const auto& p=port.parameters();double y=1.204*p.speaker.area*acceleration/(2*pi*current.distanceMetres);
    // Reference cabinet loudness: coherent drivers divided by count. Distance
    // stays physical; this fixed software scale is shared by all profiles.
    if(!p.sealed)y=hp(dipole,y,rate,1,1/(2*pi*180));
    for(auto& f:breakup)y=f.tick(y);y=rolloff.tick(y);
    double a=current.micAngle*pi/180,cutoff=18000/(1+4*std::sin(a));
    for(auto& f:aperture)y=f.tick(y,pi*std::min(cutoff,.45*rate)/rate);
    // Software output reference: 1 Pa maps to 1 FS, equally for every profile.
    if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
    return float(x*(1-wet)+y*wet);
  }
};
Cabinet::Cabinet(unsigned r,const classic::CabinetControls& c):impl(std::make_unique<Impl>(r,c)){}
Cabinet::~Cabinet()=default;
void Cabinet::update(const classic::CabinetControls& c){if(c.kind!=impl->target.kind||c.volumeLitres!=impl->volume)throw std::runtime_error("CABINET_REBUILD_REQUIRED");impl->target=c;}
float Cabinet::tick(float x){return impl->tick(x);}
}
