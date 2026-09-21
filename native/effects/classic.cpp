#include "classic.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bb::classic {
namespace {
constexpr double pi=3.14159265358979323846;
double pot(double x) { return (std::pow(10.,2*x)-1)/99; }
template<size_t N> using Matrix=std::array<std::array<double,N>,N>;
template<size_t N> Matrix<N> invert(Matrix<N> a) {
  Matrix<N> b{}; for(size_t i=0;i<N;++i) b[i][i]=1;
  for(size_t i=0;i<N;++i) {
    size_t pivot=i; for(size_t j=i+1;j<N;++j) if(std::abs(a[j][i])>std::abs(a[pivot][i])) pivot=j;
    if(std::abs(a[pivot][i])<1e-20) throw std::runtime_error("CLASSIC_SINGULAR_CIRCUIT");
    std::swap(a[i],a[pivot]); std::swap(b[i],b[pivot]);
    const double d=a[i][i]; for(size_t j=0;j<N;++j) {a[i][j]/=d;b[i][j]/=d;}
    for(size_t k=0;k<N;++k) if(k!=i) {const double m=a[k][i]; for(size_t j=0;j<N;++j) {a[k][j]-=m*a[i][j];b[k][j]-=m*b[i][j];}}
  }
  return b;
}
double hp(whitebox::Lowpass& state,double x,double sr,double resistance,double capacitance) {
  return x-state.tick(x,1/(2*sr*resistance*capacitance));
}
}

double triodeCurrent(double vp,double vg) {
  if(vp<=0) return 0;
  const double a=600*(.01+vg/std::sqrt(300+vp*vp));
  const double softplus=std::max(0.,a)+std::log1p(std::exp(-std::abs(a)));
  const double e=vp/600*softplus;
  // Koren (1 + sign(E1)) factor: E1 is nonnegative here.
  return 2*std::pow(e,1.4)/1060;
}
void TriodeStage::init(double sr,double cathodeR,double cathodeC,double bPlus) {
  rate=sr;rk=cathodeR;ck=cathodeC;supply=bPlus;
  // DC solve uses the open-circuit capacitor, no start-up transient.
  double lo=0,hi=supply/(rp+rk);
  for(int n=0;n<64;++n) {const double i=(lo+hi)*.5; if(i>triodeCurrent(supply-(rp+rk)*i,-rk*i)) hi=i;else lo=i;}
  current=(lo+hi)*.5;dcPlate=supply-rp*current;cathodeHistory=rk*current;
}
double TriodeStage::tick(double grid) {
  const double gc=2*rate*ck, gk=1/rk+gc;
  // Solve the plate load and cathode RC together. Grid-current/loading is omitted.
  const double offset=gc*cathodeHistory/gk;
  double lo=0,hi=std::max(0.,(supply-offset)/(rp+1/gk));
  double i=std::clamp(current,lo,hi);
  auto f=[&](double v) {const double vk=v/gk+offset;return v-triodeCurrent(supply-rp*v-vk,grid-vk);};
  for(int n=0;n<12;++n) {
    const double r=f(i); if(std::abs(r)<1e-10) break;
    if(r>0) hi=i;else lo=i;
    const double h=1e-8, derivative=(f(i+h)-f(i-h))/(2*h);
    const double next=i-r/derivative;
    i=next>lo&&next<hi?next:(lo+hi)*.5;
  }
  if(std::abs(f(i))>1e-9) for(int n=0;n<24;++n) {i=(lo+hi)*.5;if(f(i)>0)hi=i;else lo=i;}
  residual=f(i);current=i;const double vk=i/gk+offset;
  if(ck>0) cathodeHistory=2*vk-cathodeHistory;
  return supply-rp*i-dcPlate;
}

void ToneStack::configure(double sr,bool british,double bass,double middle,double treble) {
  // Nodes: slope, treble-top, bass-top, mid/top-bass-bottom, output.
  Matrix<5> a{};
  auto stamp=[&](int x,int y,double g) {a[x][x]+=g;if(y>=0) {a[y][y]+=g;a[x][y]-=g;a[y][x]-=g;}};
  conductance={2*sr*(british?470e-12:250e-12),2*sr*(british?22e-9:100e-9),2*sr*(british?22e-9:47e-9)};
  slopeG=1/(british?33000.:100000.);
  sourceG=conductance[0]; // ideal voltage source; preceding-stage loading is reduced
  a[0][0]+=slopeG;a[1][1]+=sourceG;
  stamp(0,2,conductance[1]);stamp(0,3,conductance[2]);
  stamp(2,3,1/(1+(british?1e6:250000)*pot(bass)));
  stamp(3,-1,1/(1+(british?25000:10000)*middle));
  stamp(1,4,1/(1+250000*(1-treble)));stamp(4,3,1/(1+250000*treble));
  stamp(4,-1,1/1e6);inverse=invert(a);
}
double ToneStack::tick(double input) {
  const std::array<double,5> rhs={slopeG*input+conductance[1]*history[1]+conductance[2]*history[2],
    sourceG*(input-history[0]),-conductance[1]*history[1],-conductance[2]*history[2],0};
  std::array<double,5> v{};
  for(int i=0;i<5;++i)for(int j=0;j<5;++j)v[i]+=inverse[i][j]*rhs[j];
  history[0]=2*(input-v[1])-history[0];history[1]=2*(v[0]-v[2])-history[1];history[2]=2*(v[0]-v[3])-history[2];
  return v[4];
}
Amp::Amp(unsigned sr,const AmpControls& c):target(c),current(c),rate(sr*4.),smooth(1-std::exp(-1/(.01*sr))),wet(c.enabled?1:0) {
  const bool lead=c.kind==AmpKind::Lead2203;
  stages[0].init(rate,lead?2700:1500,lead?.68e-6:25e-6);
  stages[1].init(rate,lead?10000:1500,lead?0:25e-6);
  stages[2].init(rate,820,0);
  stack.configure(rate,lead,c.bass,c.middle,c.treble);
  double sum=0;for(int i=0;i<129;++i) {const double d=i-64.;kernel[i]=(d==0?.225:std::sin(pi*.225*d)/(pi*d))*(.42-.5*std::cos(2*pi*i/128)+.08*std::cos(4*pi*i/128));sum+=kernel[i];}for(auto& k:kernel)k/=sum;
}
void Amp::update(const AmpControls& c) {if(c.kind!=target.kind)throw std::runtime_error("CLASSIC_REBUILD_REQUIRED");target=c;}
double Amp::circuit(double x) {
  const bool lead=target.kind==AmpKind::Lead2203;
  x=hp(coupling[0],x,rate,1e6,22e-9);
  // Fixed nominal Miller pole; capacitance is not a fitted device measurement.
  x=miller[0].tick(x,1/(2*rate*34000*120e-12));
  x=stages[0].tick(x);
  if(!lead)x=stack.tick(x); // early tone stack changes what reaches stage 2
  x=hp(coupling[1],x,rate,1e6,22e-9)*pot(current.gain);
  x=miller[1].tick(x,1/(2*rate*100000*120e-12));
  x=stages[1].tick(x);
  if(lead) {
    x=hp(coupling[2],x,rate,470000,22e-9)*.5;
    x=miller[2].tick(x,1/(2*rate*100000*120e-12));
    x=stages[2].tick(x);x=stack.tick(x); // ideal unity cathode-follower reduction
  }
  return hp(coupling[3],x,rate,1e6,22e-9)*pot(current.master)/40;
}
float Amp::tick(float input) {
  const double safe=std::isfinite(input)?input:0;
  auto approach=[&](double& v,double t){v+=(t-v)*smooth;};
  approach(current.gain,target.gain);approach(current.bass,target.bass);approach(current.middle,target.middle);approach(current.treble,target.treble);approach(current.master,target.master);approach(current.inputVolts,target.inputVolts);approach(wet,target.enabled?1:0);
  if(++controlClock==16){controlClock=0;stack.configure(rate,target.kind==AmpKind::Lead2203,current.bass,current.middle,current.treble);}
  const double drySample=dry[dryPos];dry[dryPos]=float(safe);dryPos=(dryPos+1)%32;
  up[upPos]=std::clamp(safe*current.inputVolts,-20.,20.);double result=0;
  for(unsigned phase=0;phase<4;++phase) {
    double v=0;for(unsigned k=phase,age=0;k<129;k+=4,++age)v+=kernel[k]*up[(upPos+33-age)%33]*4;
    down[downPos]=circuit(v);
    if(phase==0)for(unsigned k=0;k<129;++k)result+=kernel[k]*down[(downPos+129-k)%129];
    downPos=(downPos+1)%129;
  }
  upPos=(upPos+1)%33;
  if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
  return float(drySample*(1-wet)+result/current.inputVolts*wet);
}

Cabinet::Cabinet(unsigned sr,const CabinetControls& c):rate(sr),smooth(1-std::exp(-1/(.02*sr))),wet(c.enabled?1:0),target(c),current(c) {coefficients();}
void Cabinet::update(const CabinetControls& c) {if(c.kind!=target.kind)throw std::runtime_error("CLASSIC_REBUILD_REQUIRED");target=c;}
void Cabinet::coefficients() {
  // C12N 8 ohm: Re=6.05, Le=.9mH, Bl=10.46, Mms=29.9g,
  // Cms=66um/N, Qms=7.52, Sd=.04909m2. Fs derived from Mms/Cms.
  constexpr double re=6.05,le=.0009,bl=10.46,m=.0299,c=.000066,sd=.04909;
  const double rm=std::sqrt(m/c)/7.52;
  const double drivers=target.kind==CabinetKind::Sealed412?4:target.kind==CabinetKind::Open212?2:1;
  const double stiffness=1/c+(target.kind==CabinetKind::Sealed412?1.204*343*343*sd*sd*drivers/(current.volumeLitres*.001):0);
  Matrix<3> a={{{-re/le,-bl/le,0},{bl/m,-rm/m,-stiffness/m},{0,1,0}}},left{},right{};
  const double h=.5/rate;
  for(int i=0;i<3;++i)for(int j=0;j<3;++j){left[i][j]=(i==j?1:0)-h*a[i][j];right[i][j]=(i==j?1:0)+h*a[i][j];}
  const auto inv=invert(left);transition={};
  for(int i=0;i<3;++i){excitation[i]=inv[i][0]*h/le;for(int j=0;j<3;++j)for(int k=0;k<3;++k)transition[i][j]+=inv[i][k]*right[k][j];}
}
float Cabinet::tick(float input) {
  const double x=std::isfinite(input)?input:0;
  current.volumeLitres+=(target.volumeLitres-current.volumeLitres)*smooth;
  current.distanceMetres+=(target.distanceMetres-current.distanceMetres)*smooth;
  current.micAngle+=(target.micAngle-current.micAngle)*smooth;
  wet+=((target.enabled?1:0)-wet)*smooth;if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
  if(++clock==32){clock=0;coefficients();}
  std::array<double,3> next{};
  // 1 normalized sample -> 1 V at each driver. No invented power-amp feedback.
  for(int i=0;i<3;++i){next[i]=excitation[i]*(x+previousInput);for(int j=0;j<3;++j)next[i]+=transition[i][j]*state[j];}
  previousInput=x;state=next;
  const double acceleration=(state[1]-previousVelocity)*rate;previousVelocity=state[1];
  const double drivers=target.kind==CabinetKind::Sealed412?4:target.kind==CabinetKind::Open212?2:1;
  // On-axis far-field piston pressure, normalized with a fixed Pa -> digital gain.
  double pressure=1.204*.04909*drivers*acceleration/(2*pi*current.distanceMetres)*2;
  if(target.kind!=CabinetKind::Sealed412)pressure=hp(radiation,pressure,rate,1,1/(2*pi*180)); // declared baffle/dipole approximation
  const double cutoff=5000/(1+2*std::sin(current.micAngle*pi/180));
  for(auto& pole:aperture)pressure=pole.tick(pressure,std::tan(pi*std::min(rate*.4,cutoff)/rate));
  return float(x*(1-wet)+pressure*wet);
}

Modulation::Modulation(unsigned sr,const ModControls& c):rate(sr),smooth(1-std::exp(-1/(.01*sr))),wet(c.enabled?1:0),target(c),current(c),delay(sr/10+4,0) {}
void Modulation::update(const ModControls& c) {if(c.kind!=target.kind)throw std::runtime_error("CLASSIC_REBUILD_REQUIRED");target=c;}
float Modulation::tick(float input) {
  const double dry=std::isfinite(input)?input:0;
  auto approach=[&](double& v,double t){v+=(t-v)*smooth;};
  approach(current.rateHz,target.rateHz);approach(current.depth,target.depth);approach(current.mix,target.mix);approach(current.feedback,target.feedback);approach(current.manual,target.manual);approach(wet,target.enabled?1:0);
  phase+=current.rateHz/rate;phase-=std::floor(phase);
  const double triangle=1-4*std::abs(phase-.5);
  double result=dry;
  if(target.kind==ModKind::Phase90) {
    const double x=hp(inputCoupling,dry,rate,470000,10e-9);double shifted=x;
    // Matched JFETs are reduced to a positive variable conductance; not a calibrated Vgs law.
    const double resistance=24000/(1+19*(.5+.5*triangle)*current.depth);
    const double g=1/(2*rate*resistance*47e-9);
    for(auto& pole:allpass)shifted=2*pole.tick(shifted,g)-shifted;
    result=hp(outputCoupling,x*(1-current.mix)+shifted*current.mix,rate,150000,47e-9);
  } else if(target.kind==ModKind::OpticalTremolo) {
    const double light=.5+.5*std::sin(2*pi*phase),tau=light>ldr?.008:.08;
    ldr+=(light-ldr)*(1-std::exp(-1/(tau*rate)));
    // LDR to ground with series resistor, positive conductances and optical lag.
    result=dry/(1+9*current.depth*ldr);
  } else if(target.kind==ModKind::Chorus||target.kind==ModKind::Flanger) {
    const bool flange=target.kind==ModKind::Flanger;
    double v=dry;for(auto& pole:antiAlias)v=pole.tick(v,std::tan(pi*std::min(rate*.4,6000.)/rate));
    const double milliseconds=flange?(.4+7*current.manual+3*current.depth*(triangle+1)):(7+4*current.depth*triangle);
    const double frames=std::clamp(milliseconds*rate/1000,1.,double(delay.size()-2));
    const double read=position+delay.size()-frames;const auto i=size_t(read)%delay.size();const double f=read-std::floor(read);
    double delayed=delay[i]*(1-f)+delay[(i+1)%delay.size()]*f;
    for(auto& pole:reconstruction)delayed=pole.tick(delayed,std::tan(pi*std::min(rate*.4,6000.)/rate));
    delay[position]=v+(flange?delayed*current.feedback:0);position=(position+1)%delay.size();
    result=dry*(1-current.mix)+delayed*current.mix;
  } else if(target.kind==ModKind::Wah) {
    // TPT state-variable realization of a damped series RLC resonator (L=.5 H).
    const double hz=350*std::pow(6.,current.manual),q=1+7*current.depth;
    const double g=std::tan(pi*std::min(rate*.4,hz)/rate),r=1/q;
    const double v1=(wah1+g*(dry-wah2))/(1+g*(g+r));const double v2=wah2+g*v1;
    wah1=2*v1-wah1;wah2=2*v2-wah2;
    result=dry*(1-current.mix)+v1*r*current.mix*2;
  } else if(target.kind==ModKind::Compressor) {
    // Ideal full-wave RC sidechain + OTA differential pair. No Dyna Comp replica claim.
    const double detector=std::abs(dry),tau=detector>envelope?.002:.05+.95*current.manual;
    envelope+=(detector-envelope)*(1-std::exp(-1/(tau*rate)));
    const double threshold=.02+.48*(1-current.depth),bias=1/(1+envelope/threshold);
    result=2*bias*.2*std::tanh(dry/.2);result=dry*(1-current.mix)+result*current.mix;
  }
  if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
  return float(dry*(1-wet)+result*wet);
}
}
