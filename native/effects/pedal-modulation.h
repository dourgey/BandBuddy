#pragma once
#include "classic.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace bb::pedals {
// Independent, bounded digital implementations of documented control behavior.
// No claim to the closed firmware or a complete BBD/active-wah circuit.
class Modulator {
  static constexpr double pi=3.14159265358979323846;
  double rate,smooth,phase=0,grain=0,wet,bassBlend,envelope=0,motion=0,randomValue=0,delayFrames=0,sv1=0,sv2=0;
  unsigned channel,position=0,lastStep=99;
  uint32_t rng=0x41c64e6d;
  classic::ModControls target,current;
  std::vector<double> buffer;
  whitebox::Lowpass lowBass,lowTone,highTone,feedbackTone,bandLimit[2];
  double noise(){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return double(rng)/2147483648.-1;}
  double read(double frames,bool cubic=true)const{
    double at=position+buffer.size()-std::clamp(frames,2.,double(buffer.size()-4));size_t i=size_t(at)%buffer.size();double f=at-std::floor(at);
    double b=buffer[i],c=buffer[(i+1)%buffer.size()];if(!cubic)return b+(c-b)*f;
    double a=buffer[(i+buffer.size()-1)%buffer.size()],d=buffer[(i+2)%buffer.size()];
    return b+.5*f*(c-a+f*(2*a-5*b+4*c-d+f*(3*(b-c)+d-a)));
  }
  double lp(whitebox::Lowpass& f,double x,double hz){return f.tick(x,std::tan(pi*std::min(rate*.4,hz)/rate));}
public:
  Modulator(unsigned sr,const classic::ModControls& c,unsigned side):rate(sr),smooth(1-std::exp(-1/(.01*sr))),wet(c.enabled?1:0),bassBlend(c.bassFilter?1:0),channel(side),target(c),current(c),buffer(size_t(sr*.12)+8,0){delayFrames=6*rate/1000;}
  void update(const classic::ModControls& c){target=c;}
  float tick(float input){
    const double x=std::isfinite(input)?std::clamp(double(input),-32.,32.):0;
    auto approach=[&](double& v,double t){v+=(t-v)*smooth;};
    approach(current.rateHz,target.rateHz);approach(current.depth,target.depth);approach(current.mix,target.mix);approach(current.feedback,target.feedback);approach(current.manual,target.manual);approach(current.bass,target.bass);approach(current.treble,target.treble);approach(current.levelDb,target.levelDb);approach(wet,target.enabled?1:0);
    const double rect=std::abs(x);envelope+=(rect-envelope)*(1-std::exp(-1/(rate*(rect>envelope?.005:.08))));
    double frequency=current.rateHz;
    if(target.kind==classic::ModKind::AqueductVibrato&&target.waveform==6)frequency=.1+9.9*std::clamp(envelope*(2+2*current.rateHz),0.,1.);
    const double before=phase;phase+=frequency/rate;phase-=std::floor(phase);if(phase<before)randomValue=noise();
    double y=x;
    if(target.kind==classic::ModKind::StereoChorus){
      approach(bassBlend,target.bassFilter?1:0);
      const double low=lp(lowBass,x,120)*bassBlend,source=x-low;
      const double p=phase+(channel?.25:0),ms=9+7*current.depth*std::sin(2*pi*p);
      buffer[position]=source;double delayed=read(ms*rate/1000);
      const double bass=lp(lowTone,delayed,350),treble=delayed-lp(highTone,delayed,2500);
      delayed+=(std::pow(10.,(current.bass-.5)*12/20)-1)*bass+(std::pow(10.,(current.treble-.5)*12/20)-1)*treble;
      y=x*(1-current.mix)+(delayed+low)*current.mix;
    }else if(target.kind==classic::ModKind::StepFlanger){
      double positionControl=.5;
      if(target.sweepMode==0)positionControl=current.rateHz<.001?current.depth:.5+current.depth*(.5-2*std::abs(phase-.5));
      else if(target.sweepMode==1){
        unsigned step=unsigned(phase*8)%8;const unsigned pattern=std::min(3u,unsigned(current.depth*4));
        if(step!=lastStep){lastStep=step;if(pattern==3)randomValue=noise();}
        constexpr unsigned bounce[8]={0,2,4,6,7,5,3,1};
        positionControl=pattern==0?(7-step)/7.:pattern==1?bounce[step]/7.:pattern==2?step/7.:(randomValue+1)*.5;
      }else positionControl=.5+.5*(2*current.depth-1)*std::clamp(envelope*(2+2*current.rateHz),0.,1.);
      // Smooth discontinuous step targets; loop interpolation is convex, with
      // a passive low-pass and |feedback| <= .85, so the loop remains bounded.
      delayFrames+=((.2+11.8*positionControl)*rate/1000-delayFrames)*(1-std::exp(-1/(rate*.0015)));
      const double delayed=lp(feedbackTone,read(delayFrames,false),10000);
      buffer[position]=x+delayed*current.feedback;y=x*(1-current.mix)+delayed*current.mix;
    }else if(target.kind==classic::ModKind::AqueductVibrato){
      double shape=std::sin(2*pi*phase);
      if(target.waveform==1)shape=1-4*std::abs(phase-.5);
      if(target.waveform==2)shape=1-2*phase;
      if(target.waveform==3)shape=phase<.5?1:-1;
      if(target.waveform==4)shape=randomValue;
      double semitones=2*current.depth*shape;
      if(target.waveform==5)semitones*=std::clamp(envelope*(2+18*current.depth),0.,1.);
      if(target.waveform==7)semitones=-2*std::clamp(envelope*(2+2*current.rateHz),0.,1.);
      motion+=(semitones-motion)*(1-std::exp(-1/(rate*.002)));
      // Integrate the requested read-speed ratio; two complementary grain
      // windows avoid an unbounded delay for sustained envelope pitch bends.
      const double window=.04*rate;grain+=(1-std::exp2(motion/12))/window;grain-=std::floor(grain);
      double source=x;for(auto& f:bandLimit)source=lp(f,source,rate*.4);buffer[position]=source;
      const double other=grain+.5-std::floor(grain+.5),weight=.5-.5*std::cos(2*pi*grain);
      const double pitch=read(.002*rate+grain*window)*weight+read(.002*rate+other*window)*(1-weight);
      y=target.waveform==7?x*(1-current.depth)+pitch*current.depth:pitch;
    }else if(target.kind==classic::ModKind::FixedWah){
      const double hz=380*std::pow(2000./380,current.manual),q=.5+9.5*current.depth,g=std::tan(pi*std::min(rate*.4,hz)/rate),r=1/q;
      const double v1=(sv1+g*(x-sv2))/(1+g*(g+r)),v2=sv2+g*v1;sv1=2*v1-sv1;sv2=2*v2-sv2;
      y=v1*r*std::pow(10.,current.levelDb/20);
    }
    position=(position+1)%buffer.size();if(std::abs(wet-(target.enabled?1:0))<1e-8)wet=target.enabled?1:0;
    return float(x*(1-wet)+y*wet);
  }
};
}
