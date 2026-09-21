#include "fuzz.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace bb::whitebox {
namespace {
using Vector=std::array<double,5>;
using Matrix=std::array<Vector,5>;
struct Junction { double i,g; };
Junction diode(double v) {
  const double e=std::exp(std::clamp(v/.02585,-40.,35.));
  return {1e-14*(e-1),1e-14*e/.02585};
}
bool eliminate(Matrix a,Vector b,Vector& out) {
  for(int i=0;i<5;++i) {
    int pivot=i;for(int j=i+1;j<5;++j)if(std::abs(a[j][i])>std::abs(a[pivot][i]))pivot=j;
    if(std::abs(a[pivot][i])<1e-20)return false;
    std::swap(a[pivot],a[i]);std::swap(b[pivot],b[i]);
    for(int j=i+1;j<5;++j){const double g=a[j][i]/a[i][i];for(int k=i;k<5;++k)a[j][k]-=g*a[i][k];b[j]-=g*b[i];}
  }
  for(int i=4;i>=0;--i){double x=b[i];for(int j=i+1;j<5;++j)x-=a[i][j]*out[j];out[i]=x/a[i][i];}
  return true;
}
}
bool FuzzCircuit::solve(double input,double fuzz,bool dc) {
  // Nodes: Q1 base, Q1 collector/Q2 base, Q2 emitter, Q2 collector, output tap.
  const double gcIn=2*rate*2.2e-6,gcOut=2*rate*10e-9,gcEm=dc?0:2*rate*20e-6;
  const double gIn=dc?0:1/(10000+1/gcIn),gOut=dc?0:1/(500000+1/gcOut);
  const double top=1+1000*(1-fuzz),bottom=1+1000*fuzz;
  const double ge=1/(top+1/(1/bottom+gcEm)),offset=gcEm*emitterHistory/(1/bottom+gcEm);
  for(int iteration=0;iteration<(dc?100:40);++iteration) {
    Matrix j{};Vector r{};
    auto resistor=[&](int a,int b,double g,double fixed=0.) {
      const double i=g*(nodes[a]-(b>=0?nodes[b]:fixed));r[a]+=i;j[a][a]+=g;
      if(b>=0){r[b]-=i;j[b][b]+=g;j[a][b]-=g;j[b][a]-=g;}
    };
    resistor(0,-1,gIn,input-inputHistory);resistor(0,2,1/100000.);
    resistor(1,-1,1/33000.,9);resistor(2,-1,ge,offset);
    resistor(3,4,1/8200.);resistor(4,-1,1/470.,9);resistor(4,-1,gOut,outputHistory);
    auto transistor=[&](int b,int c,int e,double beta) {
      const auto be=diode(nodes[b]-(e>=0?nodes[e]:0)),bc=diode(nodes[b]-nodes[c]);
      const double af=beta/(beta+1),ar=2./3;
      r[b]+=(1-af)*be.i+(1-ar)*bc.i;r[c]+=af*be.i-bc.i;if(e>=0)r[e]+=-be.i+ar*bc.i;
      j[b][b]+=(1-af)*be.g+(1-ar)*bc.g;j[b][c]-=(1-ar)*bc.g;if(e>=0)j[b][e]-=(1-af)*be.g;
      j[c][b]+=af*be.g-bc.g;j[c][c]+=bc.g;if(e>=0)j[c][e]-=af*be.g;
      if(e>=0){j[e][b]+=-be.g+ar*bc.g;j[e][c]-=ar*bc.g;j[e][e]+=be.g;}
    };
    transistor(0,1,-1,120);transistor(1,3,2,180);
    error=0;for(double x:r)error=std::max(error,std::abs(x));if(error<1e-9)return true;
    Vector delta{};if(!eliminate(j,r,delta))return false;
    double largest=0;for(double x:delta)largest=std::max(largest,std::abs(x));
    double damping=largest>3?3/largest:1;
    // Limit forward junction voltage increases, not reverse collector swing.
    // This prevents one Newton step crossing dozens of thermal voltages.
    auto junctionLimit=[&](int a,int b) {const double old=nodes[a]-(b>=0?nodes[b]:0),d=delta[a]-(b>=0?delta[b]:0);if(old-d>.4&&d<-.08)damping=std::min(damping,-std::max(.08,.45-old)/d);};
    junctionLimit(0,-1);junctionLimit(0,1);junctionLimit(1,2);junctionLimit(1,3);
    for(int i=0;i<5;++i)nodes[i]-=delta[i]*damping;
  }
  return false;
}
void FuzzCircuit::init(double sr,double fuzz) {
  rate=sr;if(!solve(0,fuzz,true))throw std::runtime_error("FUZZ_DC_OPERATING_POINT_FAILED");
  inputHistory=-nodes[0];emitterHistory=nodes[2]*(1+1000*fuzz)/1002;outputHistory=nodes[4];
}
double FuzzCircuit::tick(double input,double fuzz) {
  const auto before=nodes;
  if(!solve(input,fuzz,false)){nodes=before;++failures;return lastOutput;}
  const double gcIn=2*rate*2.2e-6,gcOut=2*rate*10e-9,gcEm=2*rate*20e-6;
  const double inI=(input-nodes[0]-inputHistory)/(10000+1/gcIn);
  inputHistory+=2*inI/gcIn;
  const double top=1+1000*(1-fuzz),bottom=1+1000*fuzz;
  const double e=(nodes[2]/top+gcEm*emitterHistory)/(1/top+1/bottom+gcEm);
  emitterHistory=2*e-emitterHistory;
  const double outI=(nodes[4]-outputHistory)/(500000+1/gcOut);
  outputHistory+=2*outI/gcOut;
  return lastOutput=500000*outI;
}
}
