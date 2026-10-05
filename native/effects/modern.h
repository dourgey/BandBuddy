#pragma once
#include <array>
#include <algorithm>
#include <cmath>
#include <vector>

namespace bb {
/** Orthogonal eight-line FDN. The stereo projections are mutually orthogonal. */
class RoomNetwork {
  std::array<std::vector<float>,8> lines;
  std::array<unsigned,8> positions{};
  std::array<float,8> damp{};
  float rate=48000;
  float lastDecay=-1;bool lastRoom=false;std::array<float,8> feedback{};
 public:
  void init(unsigned sr) {
    rate=float(sr);
    constexpr std::array<float,8> seconds{.0297f,.0371f,.0411f,.0437f,.0531f,.0613f,.0719f,.0797f};
    for(unsigned i=0;i<8;i++)lines[i].assign(unsigned(sr*seconds[i])+3,0);
  }
  std::array<float,2> tick(float left,float right,float decay,float damping,bool room) {
    if(decay!=lastDecay||room!=lastRoom){for(unsigned k=0;k<8;++k)feedback[k]=std::pow(.001f,float(lines[k].size())*(room?.48f:1.f)/(rate*std::max(.1f,decay)));lastDecay=decay;lastRoom=room;}
    std::array<float,8> y{},h{};
    for(unsigned k=0;k<8;k++) {
      const auto n=unsigned(lines[k].size());
      const unsigned delay=room?unsigned(n*.48f):n-1;
      y[k]=lines[k][(positions[k]+n-delay)%n];
      damp[k]+=(y[k]-damp[k])*(1-damping*.94f);h[k]=damp[k];
    }
    // Fast Walsh-Hadamard transform, normalized to preserve feedback energy.
    for(unsigned stride=1;stride<8;stride*=2)for(unsigned start=0;start<8;start+=2*stride)for(unsigned j=0;j<stride;j++) {
      const float a=h[start+j],b=h[start+j+stride];h[start+j]=a+b;h[start+j+stride]=a-b;
    }
    for(unsigned k=0;k<8;k++) {
      const float injection=(left+(k&1?-right:right))*.18f;
      lines[k][positions[k]]=injection+h[k]*.35355339f*feedback[k];
      positions[k]=(positions[k]+1)%unsigned(lines[k].size());
    }
    return {(y[0]+y[1]-y[2]-y[3]+y[4]+y[5]-y[6]-y[7])*.35f,
            (y[0]-y[1]+y[2]-y[3]+y[4]-y[5]+y[6]-y[7])*.35f};
  }
};
}
