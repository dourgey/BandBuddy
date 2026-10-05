#pragma once
#include <array>
#include <cmath>
#include <algorithm>
#include <vector>
struct ArsenalPcmConverter {
  std::array<float,8192> ring{};long long total=0;double next=0,source=0;
  void reset(){total=0;next=0;source=0;}
  std::vector<float> convert(const std::vector<float>& input,double inRate,double outRate){
    if(inRate==outRate)return input;
    if(source!=inRate){reset();source=inRate;}
    std::vector<float> out;out.reserve(size_t(input.size()*outRate/inRate)+64);const double step=inRate/outRate,cutoff=std::min(1.,outRate/inRate)*.94,pi=3.141592653589793;
    for(size_t i=0;i<input.size()/2;++i){for(int c=0;c<2;++c)ring[(total%4096)*2+c]=input[i*2+c];++total;while(next+16<total){const auto center=static_cast<long long>(std::floor(next));double sum[2]{},norm=0;for(int k=-15;k<=16;++k){const double d=next-(center+k),x=d*cutoff,w=(std::abs(x)<1e-8?1:std::sin(pi*x)/(pi*x))*cutoff*.5*(1+std::cos(pi*d/16));norm+=w;const auto index=center+k;if(index>=0&&index<total)for(int c=0;c<2;++c)sum[c]+=ring[(index%4096)*2+c]*w;}for(int c=0;c<2;++c)out.push_back(float(sum[c]/norm));next+=step;}}
    return out;
  }
};
// Difference-function pitch detector. Called on the control thread, never the audio callback.
inline float arsenalPitch(const std::array<float,2048>& x,double rate){
  double energy=0;for(float v:x)energy+=v*v;if(energy/x.size()<1e-7)return 0;
  const int maximum=std::min(900,int(rate/30));std::array<double,902> normalized{};double sum=0;
  for(int lag=1;lag<=maximum;++lag){double d=0;for(int i=0;i<1024;++i){double delta=x[i]-x[i+lag];d+=delta*delta;}sum+=d;normalized[lag]=sum>0?d*lag/sum:1;}
  for(int lag=std::max(2,int(rate/1200));lag<maximum-1;++lag)if(normalized[lag]<.13){while(lag<maximum-1&&normalized[lag+1]<normalized[lag])++lag;double a=normalized[lag-1],b=normalized[lag],c=normalized[lag+1],den=a-2*b+c;double offset=std::abs(den)>1e-12?.5*(a-c)/den:0;return float(rate/(lag+std::clamp(offset,-.5,.5)));}
  return 0;
}
