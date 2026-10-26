#pragma once
#include "whitebox.h"
#include <algorithm>
#include <array>
#include <cmath>

namespace bb::pedals {
// Circuit connections and component values adapted from ChowCentaur Traditional,
// BSD-3-Clause, f3bb633a593b6fbb22a44c1ef9d1dbedbfe92d5b. See Pedal-NOTICES.txt.
// Independent trapezoidal nodal solver; all parallel paths run at the SAME rate.
template<size_t N, size_t C> struct PassiveNetwork {
  struct Cap { int a,b; double g,history=0; };
  std::array<Cap,C> caps;
  std::array<std::array<double,N>,N> matrix{},inverse{};
  std::array<double,N> drive{},values{};
  // Node -1 is ground, -2 is the ideal input source.
  void stamp(int a,int b,double g) {
    if(a>=0){matrix[a][a]+=g;if(b>=0)matrix[a][b]-=g;else if(b==-2)drive[a]+=g;}
    if(b>=0){matrix[b][b]+=g;if(a>=0)matrix[b][a]-=g;else if(a==-2)drive[b]+=g;}
  }
  void begin(){matrix={};drive={};for(const auto& c:caps)stamp(c.a,c.b,c.g);}
  void finish(){auto a=matrix;inverse={};for(size_t i=0;i<N;++i)inverse[i][i]=1;
    for(size_t i=0;i<N;++i){double d=a[i][i];for(size_t j=0;j<N;++j){a[i][j]/=d;inverse[i][j]/=d;}
      for(size_t k=0;k<N;++k)if(k!=i){double f=a[k][i];for(size_t j=0;j<N;++j){a[k][j]-=f*a[i][j];inverse[k][j]-=f*inverse[i][j];}}}
  }
  void tick(double input){auto b=drive;for(auto& v:b)v*=input;
    for(const auto& c:caps){if(c.a>=0)b[c.a]+=c.g*c.history;if(c.b>=0)b[c.b]-=c.g*c.history;}
    values={};for(size_t i=0;i<N;++i)for(size_t j=0;j<N;++j)values[i]+=inverse[i][j]*b[j];
    auto v=[&](int n){return n>=0?values[n]:n==-2?input:0;};for(auto& c:caps)c.history=2*(v(c.a)-v(c.b))-c.history;
  }
};
class Centaur {
  double rate,lastGain=-1,lastTone=-1,clipLeft=0,clipRight=0;
  unsigned clock=0;
  PassiveNetwork<3,3> pre;
  PassiveNetwork<5,4> ff2;
  whitebox::Lowpass inputCoupling,sum,outputCoupling;
  whitebox::DiodePort diode;
  std::array<double,3> a{},b{};
  double z1=0,z2=0,tb0=0,tb1=0,ta1=0,tz=0;
  void configure(double gain,double tone){
    if(std::abs(gain-lastGain)>1e-8){lastGain=gain;
      pre.begin();pre.stamp(0,1,1/10000.);pre.stamp(1,-1,1/std::max(1.,gain*100000));pre.stamp(0,2,1/1500.);pre.stamp(2,-1,1/15000.);pre.finish();
      ff2.begin();ff2.stamp(-2,0,1/5100.);ff2.stamp(0,-1,1/1500.);ff2.stamp(4,-1,1/1000.);
      ff2.stamp(0,1,1/std::max(1.,gain*100000));ff2.stamp(1,-1,1/std::max(1.,(1-gain)*100000));ff2.stamp(1,-1,1/27000.);ff2.stamp(2,-1,1/69000.);ff2.stamp(3,-1,1/12000.);ff2.finish();
      const double r=(1-gain)*100000+2000,k=2*rate;
      const double a2=82e-9*390e-12*r*15000*422000,a1=82e-9*r*15000+390e-12*422000*(r+15000),a0=r+15000;
      const double b2=a2,b1=a1+82e-9*15000*422000,b0=a0+422000,d=a2*k*k+a1*k+a0;
      a={1,(2*a0-2*a2*k*k)/d,(a2*k*k-a1*k+a0)/d};b={(b2*k*k+b1*k+b0)/d,(2*b0-2*b2*k*k)/d,(b2*k*k-b1*k+b0)/d};
    }
    if(std::abs(tone-lastTone)>1e-8){lastTone=tone;
      // Published active treble transfer with the reference's stable pole map.
      const double g1=1/100000.,g2=1/(1800+(1-tone)*10000),g3=1/(4700+tone*10000),g4=g1,c=3.9e-9,wc=g1/c,k=wc/std::tan(wc/(2*rate));
      const double bs1=c*(g1+g2),bs0=g1*(g2+g3),as1=c*(g3-g4),as0=-g4*(g2+g3),d=as0-k*as1;
      ta1=(as0+k*as1)/d;tb0=(bs0+k*bs1)/d;tb1=(bs0-k*bs1)/d;
    }
  }
public:
  // Diagnostics for independent circuit response and nonlinear residual tests.
  std::array<double,3> branches()const{return {pre.values[0],pre.values[2]/15000,ff2.values[2]/69000};}
  double clipResidual()const{return diode.residual;}
  Centaur(double sr,double gain,double tone):rate(sr){
    pre.caps={{{-2,0,2*sr*.1e-6},{0,1,2*sr*68e-9},{2,-1,2*sr*1e-6}}};
    ff2.caps={{{-2,0,2*sr*68e-9},{1,2,2*sr*2.2e-9},{1,3,2*sr*27e-9},{0,4,2*sr*390e-9}}};configure(gain,tone);
  }
  double tick(double input,double gain,double tone,double level){
    if(++clock==64){clock=0;configure(gain,tone);}
    const double x=(input-inputCoupling.tick(input,1/(2*rate*1010000*.1e-6)))*1000000/1010000;
    pre.tick(x);ff2.tick(x);
    double v=b[0]*pre.values[0]+z1;z1=b[1]*pre.values[0]-a[1]*v+z2;z2=b[2]*pre.values[0]-a[2]*v;v=std::clamp(v,-4.5,4.5);
    const double gc=2*rate*1e-6,gl=1/(1000+1/gc),gr=1/(47000+1/gc);
    const double clip=diode.solve(gl+gr,gl*(v-clipLeft)+gr*clipRight,1,15e-6,.02585);
    const double il=gl*(v-clipLeft-clip),ir=gr*(clip-clipRight);clipLeft+=2*il/gc;clipRight+=2*ir/gc;
    const double mixed=std::clamp(sum.tick(392000*(pre.values[2]/15000+ff2.values[2]/69000+ir),1/(2*rate*392000*820e-12)),-13.1,11.7);
    const double toned=tb0*mixed+tz;tz=tb1*mixed-ta1*toned;
    return (toned-outputCoupling.tick(toned,1/(2*rate*10561*4.7e-6)))*(level*10000/10561);
  }
};
}
