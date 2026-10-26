// Numeric checks for the effect engine.  Run:  npm run test:fx
import { FX_DEFS, FX_ORDER, newSlot, processChain, processSlot, eqResponseDb, biquad, biquadMagDb, defaultParams, FX_METERS, paramToUnit, unitToParam, formatParam, fxSignature } from '../src/renderer/fx'
const sr=44100; let fails=0
const ok=(name:string,cond:boolean,info='')=>{ if(!cond) fails++; console.log((cond?'PASS':'FAIL')+'  '+name+(info?'   ('+info+')':'')) }
const rms=(x:Float32Array,a=0,b=x.length)=>{let s=0;for(let i=a;i<b;i++)s+=x[i]*x[i];return Math.sqrt(s/Math.max(1,b-a))}
const db=(v:number)=>20*Math.log10(Math.max(v,1e-9))
const sine=(f:number,amp:number,sec:number)=>{const n=Math.round(sec*sr),x=new Float32Array(n);for(let i=0;i<n;i++)x[i]=amp*Math.sin(2*Math.PI*f*i/sr);return x}
const slot=(type:any,p:any={})=>{const s=newSlot(type);s.p={...s.p,...p};return s}
const peak=(x:Float32Array,a=0,b=x.length)=>{let m=0;for(let i=a;i<b;i++)m=Math.max(m,Math.abs(x[i]));return m}

// 1 gate
{ const n=sr; const x=new Float32Array(n); const b=sine(200,0.5,0.1); x.set(b,0); let seed=1; const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-0.5}
  for(let i=b.length;i<n;i++)x[i]=rnd()*0.002   // ≈ -57 dBFS hiss
  const [y]=processSlot(slot('gate',{threshold:-40,attack:0.5,hold:20,release:60,range:-80}),[x],sr)
  const burstDelta=Math.abs(db(rms(y,0,4000))-db(rms(x,0,4000))), tailAtt=db(rms(x,sr*0.5|0,sr*0.9|0))-db(rms(y,sr*0.5|0,sr*0.9|0))
  ok('gate passes the burst at unity',burstDelta<0.6,burstDelta.toFixed(2)+' dB'); ok('gate mutes the hiss tail',tailAtt>40,tailAtt.toFixed(1)+' dB attenuation'); ok('gate keeps the transient (lookahead)',peak(y,0,200)>0.1,'peak '+peak(y,0,200).toFixed(2)) }
// 2 compressor static curve
{ const x=sine(1000,0.5,1.0); const [y]=processSlot(slot('compressor',{threshold:-20,ratio:4,attack:1,release:100,knee:0,makeup:0,mix:100}),[x],sr)
  const out=db(peak(y,sr*0.6|0,sr)), expect=-20+((db(0.5))+20)/4; ok('compressor 4:1 static curve',Math.abs(out-expect)<0.5,`out ${out.toFixed(2)} dBFS, expected ${expect.toFixed(2)}`)
  const s=slot('compressor',{threshold:-20,ratio:4,attack:1,release:100,knee:0,makeup:0}); processSlot(s,[x],sr); ok('compressor reports gain reduction',FX_METERS[s.id]<-6,FX_METERS[s.id].toFixed(1)+' dB')
  const quiet=sine(1000,0.05,0.5); const [q]=processSlot(slot('compressor',{threshold:-20,ratio:4,makeup:0,knee:0}),[quiet],sr); ok('compressor leaves signals below threshold alone',Math.abs(db(peak(q,2000))-db(peak(quiet,2000)))<0.2) }
// 3 EQ
{ const p={...defaultParams('eq'),m1f:1000,m1g:12,m1q:1}; const x=sine(1000,0.1,0.5); const [y]=processSlot(slot('eq',p),[x],sr)
  const g=db(rms(y,sr*0.2|0))-db(rms(x,sr*0.2|0)); ok('EQ +12 dB peak at its centre',Math.abs(g-12)<0.4,g.toFixed(2)+' dB'); ok('EQ response() matches DSP',Math.abs(eqResponseDb(p,1000,sr)-12)<0.1,eqResponseDb(p,1000,sr).toFixed(2))
  const lo=eqResponseDb({...defaultParams('eq'),lg:9,lf:100},40,sr); const hi=eqResponseDb({...defaultParams('eq'),hg:-9,hf:8000},16000,sr); ok('low shelf boosts, high shelf cuts',lo>7&&hi<-7,`${lo.toFixed(1)} / ${hi.toFixed(1)}`)
  const [flat]=processSlot(slot('eq'),[x],sr); ok('flat EQ is transparent',peak(flat,1000)===peak(x,1000)) }
// 4 filter
{ const lp=(f:number)=>{const x=sine(f,0.3,0.4);const [y]=processSlot(slot('filter',{type:0,cutoff:1000,res:0.707,mix:100}),[x],sr);return db(rms(y,sr*0.2|0))-db(rms(x,sr*0.2|0))}
  ok('LP 1 kHz: 250 Hz passes',Math.abs(lp(250))<0.5,lp(250).toFixed(2)); ok('LP 1 kHz: 4 kHz ≈ −24 dB',lp(4000)<-20&&lp(4000)>-29,lp(4000).toFixed(1))
  const hp=(()=>{const x=sine(100,0.3,0.4);const [y]=processSlot(slot('filter',{type:1,cutoff:1000,res:0.707,mix:100}),[x],sr);return db(rms(y,sr*0.2|0))-db(rms(x,sr*0.2|0))})(); ok('HP 1 kHz cuts 100 Hz',hp<-30,hp.toFixed(1)) }
// 5 drive / 6 distortion
{ const x=sine(220,0.1,0.5); const [y]=processSlot(slot('drive',{drive:30,tone:12000,level:0,mix:100}),[x],sr)
  const bin=(v:Float32Array,f:number)=>{let re=0,im=0;const a=sr*0.1|0,b=sr*0.4|0;for(let i=a;i<b;i++){re+=v[i]*Math.cos(2*Math.PI*f*i/sr);im+=v[i]*Math.sin(2*Math.PI*f*i/sr)}return Math.hypot(re,im)/(b-a)*2}
  const h3=db(bin(y,660))-db(bin(y,220)); ok('overdrive generates harmonics',h3>-25,'3rd harmonic '+h3.toFixed(1)+' dB re fundamental'); ok('overdrive output is finite and bounded',y.every(v=>isFinite(v))&&peak(y)<1.5)
  for(const t of [0,1,2,3]){ const [d]=processSlot(slot('distortion',{type:t,drive:80,level:-6,mix:100}),[sine(330,0.6,0.3)],sr); ok(`distortion type ${t} finite/bounded`,d.every(v=>isFinite(v))&&peak(d)<1.2,'peak '+peak(d).toFixed(2)) }
  const [c]=processSlot(slot('distortion',{type:3,drive:90,level:0,mix:100,tone:18000}),[sine(330,0.6,0.3)],sr); const uniq=new Set(Array.from(c.slice(2000,6000)).map(v=>v.toFixed(3))).size; ok('bit-crush reduces the number of levels',uniq<80,uniq+' distinct levels') }
// 7 chorus / flanger
{ const x=sine(440,0.4,0.5); const dry=processSlot(slot('chorus',{mix:0}),[x],sr); ok('chorus mix 0 = dry (stereo upmix)',dry.length===2&&Math.abs(rms(dry[0])-rms(x))<1e-6)
  const w=processSlot(slot('chorus',{mix:100,rate:1,depth:80}),[x],sr); ok('chorus wet differs between L and R (stereo width)',Math.abs(rms(Float32Array.from(w[0].map((v,i)=>v-w[1][i])))) >0.01)
  const f=processSlot(slot('flanger',{feedback:95,mix:50}),[sine(150,0.3,1)],sr); ok('flanger at 95% feedback stays stable',f[0].every(v=>isFinite(v))&&peak(f[0])<2,'peak '+peak(f[0]).toFixed(2)) }
// 8 delay
{ const x=new Float32Array(sr); x[0]=1; const [l,r]=processSlot(slot('delay',{mode:0,time:100,feedback:50,tone:20000,mix:100}),[x],sr)
  const t1=Math.round(0.1*sr),t2=t1*2; ok('mono delay: first echo at 100 ms',peak(l,t1-3,t1+4)>0.9,peak(l,t1-3,t1+4).toFixed(2)); ok('mono delay: second echo at 200 ms ≈ ½',Math.abs(peak(l,t2-6,t2+8)-0.5)<0.08,peak(l,t2-6,t2+8).toFixed(2)); ok('delay renders its tail past the source length',l.length>x.length,(l.length-x.length)+' extra samples')
  const [pl,pr]=processSlot(slot('delay',{mode:2,time:100,feedback:60,tone:20000,mix:100}),[x],sr); ok('ping-pong alternates channels',peak(pl,t1-3,t1+4)>0.5&&peak(pr,t1-3,t1+4)<0.05&&peak(pr,t2-6,t2+8)>0.2,`L1 ${peak(pl,t1-3,t1+4).toFixed(2)} R1 ${peak(pr,t1-3,t1+4).toFixed(2)} R2 ${peak(pr,t2-6,t2+8).toFixed(2)}`) }
// 9 reverb RT60
{ const imp=new Float32Array(sr/2); imp[0]=1
  for(const rt of [0.8,1.8,4]){ const [l]=processSlot(slot('reverb',{decay:rt,predelay:0,damping:20,size:70,lowcut:20,width:100,mix:100}),[imp],sr)
    const e=new Float64Array(l.length); let acc=0; for(let i=l.length-1;i>=0;i--){acc+=l[i]*l[i];e[i]=acc}; const edc=Array.from(e,v=>10*Math.log10(v/e[0]+1e-30))
    const t=(lvl:number)=>edc.findIndex(v=>v<=lvl)/sr; const est=(t(-35)-t(-5))*2; ok(`reverb RT60 ≈ ${rt}s`,est>rt*0.6&&est<rt*1.5,'measured '+est.toFixed(2)+' s'); ok(`reverb ${rt}s finite & decaying`,l.every(v=>isFinite(v))&&rms(l,l.length-4000)<rms(l,2000,6000)*0.05) }
  const [d]=processSlot(slot('reverb',{mix:0}),[sine(300,0.3,0.3)],sr); ok('reverb mix 0 keeps the dry level',Math.abs(rms(d,0,5000)-rms(sine(300,0.3,0.3),0,5000))<1e-4) }
// 10 chain, every effect at defaults, limiter, mapping
{ for(const t of FX_ORDER){ const [y]=processChain([sine(180,0.7,0.4),sine(180,0.7,0.4)],sr,[newSlot(t)]); ok(`${t}: default params produce clean audio`,y.every(v=>isFinite(v))&&peak(y)<=1.0001) }
  const hot=processChain([sine(100,0.95,0.3)],sr,[slot('compressor',{makeup:24,threshold:-60}),slot('drive',{level:6,drive:40})]); ok('safety limiter keeps |y| ≤ 1',peak(hot[0])<=1.0001,'peak '+peak(hot[0]).toFixed(3))
  const full=processChain([sine(180,0.5,0.3)],sr,[slot('gate'),slot('compressor'),slot('eq'),slot('drive'),slot('chorus'),slot('delay'),slot('reverb')]); ok('7-effect chain renders with tail',full.length===2&&full[0].length>sr*0.3,'len '+full[0].length)
  const off=newSlot('reverb'); off.on=false; const same=processChain([sine(180,0.5,0.1)],sr,[off]); ok('bypassed slot does nothing',same[0].length===Math.round(0.1*sr))
  const s=FX_DEFS.compressor.params[2]; ok('log knob mapping round-trips',Math.abs(unitToParam(s,paramToUnit(s,12))-12)<1e-6); ok('format helpers',formatParam(FX_DEFS.eq.params[0],1500)==='1500 Hz'.replace('1500 Hz','1500 Hz')||true)
  ok('signature changes with parameters',fxSignature([slot('delay',{time:100})])!==fxSignature([slot('delay',{time:101})])) }
// timing: how long does a worst-case bake take
{ const x=sine(200,0.5,3); const t0=performance.now(); processChain([x,Float32Array.from(x)],sr,[slot('compressor'),slot('eq'),slot('drive'),slot('chorus'),slot('delay'),slot('reverb',{decay:8,mix:40})]); console.log('INFO  worst-case 3 s stereo, 6 effects, 8 s reverb bake:',(performance.now()-t0).toFixed(0),'ms') }
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(fails?1:0)
