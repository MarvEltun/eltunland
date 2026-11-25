const TAU = Math.PI * 2;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

export function rotatePoint([x, y, z], yaw, pitch) {
  const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
  const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return [rx, y * Math.cos(pitch) + rz * Math.sin(pitch), -y * Math.sin(pitch) + rz * Math.cos(pitch)];
}

function box(faces, center, size, color, part, layer = 'inside') {
  const [x, y, z] = center, [w, h, d] = size.map((v) => v / 2);
  const vertices = [
    [x-w,y-h,z-d],[x+w,y-h,z-d],[x+w,y+h,z-d],[x-w,y+h,z-d],
    [x-w,y-h,z+d],[x+w,y-h,z+d],[x+w,y+h,z+d],[x-w,y+h,z+d],
  ];
  for (const indices of [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[3,2,6,7],[4,5,1,0]]) {
    faces.push({ points: indices.map((i) => vertices[i]), color, part, layer });
  }
}

function cylinder(faces, center, radius, length, color, part, axis = 'x', layer = 'inside', segments = 28) {
  const rings = [-length/2,length/2].map((offset) => Array.from({ length: segments }, (_, i) => {
    const a = i / segments * TAU;
    if (axis === 'x') return [center[0]+offset,center[1]+Math.sin(a)*radius,center[2]+Math.cos(a)*radius];
    if (axis === 'z') return [center[0]+Math.cos(a)*radius,center[1]+Math.sin(a)*radius,center[2]+offset];
    return [center[0]+Math.cos(a)*radius,center[1]+offset,center[2]+Math.sin(a)*radius];
  }));
  faces.push({ points: rings[0], color, part, layer }, { points: [...rings[1]].reverse(), color, part, layer });
  for (let i=0;i<segments;i++) {
    const next = (i+1)%segments;
    faces.push({ points: [rings[0][i],rings[0][next],rings[1][next],rings[1][i]], color, part, layer });
  }
}

function beam(faces, a, b, width, color, part, layer = 'shell') {
  // Pillar faces are full 3D beams rather than screen-space decoration.
  const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
  const length = Math.hypot(dx,dy,dz);
  const side = Math.abs(dx) < .001 && Math.abs(dz) < .001 ? [width/2,0,0] : [dz/length*width/2,0,-dx/length*width/2];
  const depth = [0,width/2,0];
  const rings = [a,b].map((p) => [[1,1],[-1,1],[-1,-1],[1,-1]].map(([u,v]) => p.map((n,i) => n+side[i]*u+depth[i]*v)));
  faces.push({points:rings[0],color,part,layer},{points:rings[1],color,part,layer});
  for(let i=0;i<4;i++) faces.push({points:[rings[0][i],rings[0][(i+1)%4],rings[1][(i+1)%4],rings[1][i]],color,part,layer});
}

export function buildCar({ cutaway = true, exploded = 0, roofOpen = true, plate = '' } = {}) {
  const faces = [], cream = '#f6f7f4', dark = '#303d3b', chrome = '#bdc8c0', fabric = '#a52e32';
  const addBox = (c,s,color,part,layer) => box(faces,c,s,color,part,layer);
  const lift = exploded * .65;
  const engineY = .60 + lift;
  addBox([0,.31,0],[1.35,.13,2.95],'#637570','body');
  addBox([0,.45,.4],[1.27,.13,1.9],'#4b5c55','body');
  // A rounded body loft: stations describe the compact 500 silhouette.
  const stations = [
    [-1.76,.51,.40,.77],[-1.67,.68,.39,.85],[-1.42,.78,.40,.94],
    [-.86,.8,.40,1.02],[.2,.81,.40,1.04],[1.12,.76,.41,.98],[1.58,.65,.41,.85],[1.72,.47,.43,.75],
  ];
  const ring = ([z,w,bottom,top]) => [
    [-w*.8,bottom,z],[-w,bottom+.12,z],[-w,top-.12,z],[-w*.78,top,z],
    [w*.78,top,z],[w,top-.12,z],[w,bottom+.12,z],[w*.8,bottom,z],
  ];
  for(let k=0;k<stations.length-1;k++) {
    const a=ring(stations[k]), b=ring(stations[k+1]);
    for(let i=0;i<8;i++) {
      // The top between the windscreen and rear seats is open, as on a 500C.
      if(i===3 && k>=3 && k<=4) continue;
      faces.push({points:[a[i],a[(i+1)%8],b[(i+1)%8],b[i]],color:cream,part:'body',layer:'shell'});
    }
  }
  faces.push({points:ring(stations[0]),color:cream,part:'body',layer:'shell'});
  faces.push({points:ring(stations.at(-1)),color:cream,part:'body',layer:'shell'});
  for(const side of [-1,1]) {
    const x=side*.76;
    beam(faces,[x,.94,-.66],[side*.61,1.51,-.22],.07,cream,'body');
    beam(faces,[side*.61,1.51,-.22],[side*.62,1.51,.65],.065,cream,'body');
    beam(faces,[side*.62,1.51,.65],[side*.72,.96,1.21],.1,cream,'body');
    beam(faces,[side*.77,.99,.43],[side*.62,1.51,.43],.045,cream,'body');
    addBox([side*.81,.82,.22],[.025,.027,.22],chrome,'body','shell');
    addBox([side*.86,1.05,-.46],[.17,.09,.13],cream,'body','shell');
    faces.push({points:[[side*.76,1,-.60],[side*.61,1.46,-.20],[side*.61,1.46,.39],[side*.76,1,.39]],color:'#7d9f9e',part:'body',layer:'glass'});
    faces.push({points:[[side*.76,1,.49],[side*.63,1.46,.49],[side*.70,1.02,1.10]],color:'#7d9f9e',part:'body',layer:'glass'});
  }
  beam(faces,[-.62,1.51,-.22],[.62,1.51,-.22],.07,cream,'body');
  faces.push({points:[[-.74,1,-.66],[.74,1,-.66],[.60,1.48,-.22],[-.60,1.48,-.22]],color:'#81a7a5',part:'body',layer:'glass'});
  for(const x of [-.35,.35]) {
    addBox([x,.66,.11],[.49,.18,.52],'#b0a18a','body');
    addBox([x,.92,.4],[.49,.56,.14],'#b0a18a','body');
    addBox([x,1.21,.41],[.26,.15,.1],'#a6967d','body');
    addBox([x,.73,.96],[.5,.17,.42],'#a6967d','body');
    addBox([x,.96,1.13],[.5,.38,.12],'#a6967d','body');
  }
  addBox([0,.99,-.48],[1.25,.13,.18],'#3b4945','body');
  cylinder(faces,[-.37,1.08,-.29],.14,.03,'#273b32','body','x');
  // Front engine and the six handbook engine-bay callouts.
  addBox([0,engineY,-1.03],[.72,.39,.61],'#87979a','engine');
  addBox([0,engineY+.22,-1.04],[.74,.07,.61],'#3b4e4b','engine');
  for(let i=0;i<4;i++) addBox([-.25+i*.16,engineY+.27,-.99],[.06,.025,.42],'#adb8b1','engine');
  addBox([0,.6+lift,-1.49],[.99,.29,.06],'#627774','engine');
  for(let i=0;i<10;i++) addBox([-.43+i*.095,.61+lift,-1.53],[.035,.25,.015],'#9da9a0','engine');
  cylinder(faces,[.03,engineY+.31,-1.12],.072,.05,'#e5c15b','oil-cap','y');
  cylinder(faces,[.32,engineY+.21,-1.34],.043,.08,'#e7a24f','dipstick','y');
  beam(faces,[.32,.69+lift,-1.34],[.32,.91+lift,-1.34],.015,'#9b9e8d','dipstick','inside');
  addBox([-.5,.72+lift,-1.02],[.29,.29,.43],'#406c63','battery');
  addBox([-.5,.88+lift,-1.02],[.3,.04,.45],'#294b45','battery');
  for(const z of [-1.15,-.88]) addBox([-.5,.92+lift,z],[.05,.035,.05],z<-1?'#cf876c':'#b8bdb0','battery');
  addBox([.53,.76+lift,-.82],[.23,.25,.27],'#d4b8aa','coolant');
  cylinder(faces,[.53,.92+lift,-.82],.06,.04,'#5e6762','coolant','y');
  addBox([-.45,.85+lift,-.55],[.2,.16,.17],'#d5c2a0','brake-fluid');
  cylinder(faces,[-.45,.95+lift,-.55],.065,.04,'#4e5848','brake-fluid','y');
  cylinder(faces,[.55,.76+lift,-1.37],.055,.23,'#c4d6cf','washer','y');
  cylinder(faces,[.55,.9+lift,-1.37],.073,.025,'#729fbc','washer','y');
  for(const side of [-1,1]) {
    for(const z of [-1.09,1.10]) {
      const x=side*(.78+exploded*.48), y=.34;
      cylinder(faces,[x,y,z],.325,.21,'#2d3433','wheels');
      cylinder(faces,[x+side*.111,y,z],.223,.012,'#b5bdb8','wheels');
      cylinder(faces,[x+side*.122,y,z],.169,.018,'#5d6e69','wheels');
      cylinder(faces,[x+side*.137,y,z],.085,.024,'#c5cec1','wheels');
      for(let i=0;i<10;i++) {
        const a=i/10*TAU;
        addBox([x+side*.14,y+Math.sin(a)*.143,z+Math.cos(a)*.143],[.02,.04,.04],'#d2d7cd','wheels');
      }
    }
  }
  for(const x of [-.53,.53]) {
    cylinder(faces,[x,.77,-1.69],.126,.065,chrome,'body','z','shell');
    cylinder(faces,[x,.77,-1.73],.105,.025,'#e8e4c8','body','z','shell');
    cylinder(faces,[x,.55,-1.74],.059,.04,'#ded9b8','body','z','shell');
    addBox([x,.77,1.59],[.13,.22,.07],'#a85647','body','shell');
  }
  addBox([0,.46,-1.71],[.98,.09,.08],chrome,'body','shell');
  addBox([0,.59,-1.755],[.52,.07,.025],'#344640','body','shell');
  addBox([0,.73,-1.758],[.22,.025,.025],chrome,'body','shell');
  addBox([0,.44,1.67],[.91,.07,.06],chrome,'body','shell');
  for (const [z, side] of plate ? [[-1.785, 1], [1.745, -1]] : []) {
    faces.push({
      points: [[-.34*side,.56,z],[.34*side,.56,z],[.34*side,.46,z],[-.34*side,.46,z]],
      color:'#ffffff', part:'body', layer:'shell', label:plate,
    });
  }
  if(roofOpen) {
    for(let i=0;i<6;i++) addBox([0,1.28+lift+i*.022,.96+i*.035],[1.13,.045,.20],i%2?fabric:'#c34448','roof','roof');
  } else {
    addBox([0,1.53+lift,.3],[1.17,.045,1.04],fabric,'roof','roof');
    faces.push({points:[[-.58,1.53+lift,.82],[.58,1.53+lift,.82],[.64,1.01+lift,1.22],[-.64,1.01+lift,1.22]],color:fabric,part:'roof',layer:'roof'});
    faces.push({points:[[-.45,1.42+lift,.91],[.45,1.42+lift,.91],[.5,1.11+lift,1.15],[-.5,1.11+lift,1.15]],color:'#789b97',part:'roof',layer:'roof'});
  }
  const underBonnet = new Set(['engine','oil-cap','dipstick','coolant','brake-fluid','battery','washer']);
  return faces.filter((face) => cutaway
    ? !['shell','glass'].includes(face.layer)
    : !underBonnet.has(face.part));
}

function shade(hex, value) {
  const components = hex.match(/[a-f\d]{2}/gi).map((part) => clamp(Math.round(parseInt(part,16)*value),0,255));
  return `rgb(${components.join(',')})`;
}

export function createCarScene(canvas, onSelect, onError) {
  const ctx=canvas.getContext('2d');
  if(!ctx) throw new Error('Your browser cannot create the 3D illustration canvas. Use the parts list below.');
  let options={cutaway:false,exploded:0,roofOpen:true,selected:'engine'};
  let yaw=-.66, pitch=.32, zoom=1, faces=buildCar(options), hitFaces=[], disposed=false, drag=null;
  let width=0,height=0,frame=0;
  function project(point) {
    const [x,y,z]=rotatePoint([point[0],point[1]-.7,point[2]],yaw,pitch);
    const perspective=6/(6+z);
    const scale=Math.min(width/5.05,height/2.95)*zoom;
    return {x:width/2+x*perspective*scale,y:height*.55-y*perspective*scale,z};
  }
  function draw() {
    frame=0;
    if(disposed) return;
    try {
      const ratio=Math.min(window.devicePixelRatio||1,2);
      width=canvas.clientWidth; height=canvas.clientHeight;
      if(!width||!height) return;
      if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)) {
        canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
      }
      ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
      const gradient=ctx.createRadialGradient(width*.5,height*.75,0,width*.5,height*.75,width*.5);
      gradient.addColorStop(0,'rgba(49,72,48,.15)');gradient.addColorStop(1,'rgba(49,72,48,0)');
      ctx.fillStyle=gradient;ctx.beginPath();ctx.ellipse(width*.5,height*.78,width*.34,height*.15,0,0,TAU);ctx.fill();
      ctx.strokeStyle='#c9d3be';ctx.lineWidth=.6;
      for(let n=-5;n<=5;n++) {
        const a=project([n*.5,-.05,-2.5]),b=project([n*.5,-.05,2.5]);
        const c=project([-2.5,-.05,n*.5]),d=project([2.5,-.05,n*.5]);
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.moveTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.stroke();
      }
      hitFaces=faces.map((face) => {
        const points=face.points.map(project);
        return {...face,projected:points,depth:points.reduce((sum,p)=>sum+p.z,0)/points.length};
      }).sort((a,b)=>b.depth-a.depth);
      for(const face of hitFaces) {
        const p=face.projected;
        const path=new Path2D();path.moveTo(p[0].x,p[0].y);
        for(const v of p.slice(1))path.lineTo(v.x,v.y);
        path.closePath();face.path=path;
        const a=face.points[0],b=face.points[1],c=face.points[2];
        const u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
        const normal=rotatePoint([u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],yaw,pitch);
        const light=.78+Math.abs(normal[1]/(Math.hypot(...normal)||1))*.22;
        ctx.fillStyle=shade(face.color,light);
        ctx.globalAlpha=face.layer==='glass'?.53:1;
        ctx.fill(path);
        ctx.strokeStyle=face.part===options.selected?'#d1e99a':shade(face.color,.74);
        ctx.lineWidth=face.part===options.selected?1.3:.4;
        ctx.stroke(path);ctx.globalAlpha=1;
        if(face.label) {
          ctx.save();
          ctx.clip(path);
          ctx.transform(p[1].x-p[0].x,p[1].y-p[0].y,p[3].x-p[0].x,p[3].y-p[0].y,p[0].x,p[0].y);
          ctx.fillStyle='#174e9e';ctx.fillRect(0,0,.1,1);
          ctx.fillStyle='#ffffff';ctx.font='bold .18px sans-serif';ctx.textAlign='center';
          ctx.fillText('D',.05,.83);
          ctx.fillStyle='#121714';ctx.font='bold .62px sans-serif';
          ctx.fillText(face.label,.55,.72,.88);
          ctx.restore();
        }
      }
      ctx.fillStyle='#809173';ctx.font='10px system-ui';ctx.textAlign='center';
      const front=project([0,.03,-2.12]);ctx.fillText('FRONT',front.x,front.y);
    } catch(error) {
      onError(`The 3D view could not be drawn: ${error.message}. You can still explore every part using the list.`);
    }
  }
  function requestDraw(){if(!frame&&!disposed)frame=requestAnimationFrame(draw);}
  const observer=new ResizeObserver(requestDraw);observer.observe(canvas);
  const abort=new AbortController(), events={signal:abort.signal};
  canvas.addEventListener('pointerdown',(event)=>{
    if(event.button!==0)return;
    drag={x:event.clientX,y:event.clientY,yaw,pitch,moved:false};canvas.setPointerCapture(event.pointerId);
  },events);
  canvas.addEventListener('pointermove',(event)=>{
    if(!drag)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(Math.hypot(dx,dy)>4)drag.moved=true;
    if(drag.moved){yaw=drag.yaw+dx*.009;pitch=clamp(drag.pitch+dy*.007,-.08,1.3);requestDraw();}
  },events);
  canvas.addEventListener('pointerup',(event)=>{
    if(!drag)return;
    if(!drag.moved) {
      const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
      const selected=[...hitFaces].reverse().find((face)=>ctx.isPointInPath(face.path,x*(canvas.width/width),y*(canvas.height/height)));
      if(selected)onSelect(selected.part);
    }
    drag=null;
  },events);
  canvas.addEventListener('pointercancel',()=>{drag=null;},events);
  canvas.addEventListener('keydown',(event)=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(event.key))return;
    event.preventDefault();
    if(event.key==='ArrowLeft')yaw-=.15;
    if(event.key==='ArrowRight')yaw+=.15;
    if(event.key==='ArrowUp')pitch=clamp(pitch+.12,-.08,1.3);
    if(event.key==='ArrowDown')pitch=clamp(pitch-.12,-.08,1.3);
    if(['+','='].includes(event.key))zoom=clamp(zoom*1.12,.6,1.8);
    if(event.key==='-')zoom=clamp(zoom/1.12,.6,1.8);
    if(event.key==='Home'){yaw=-.66;pitch=.32;zoom=1;}
    requestDraw();
  },events);
  requestDraw();
  return {
    update(next){options={...options,...next};faces=buildCar(options);requestDraw();},
    camera(preset){if(preset==='top'){yaw=0;pitch=1.28;zoom=1;}else if(preset==='front'){yaw=0;pitch=.15;zoom=1;}else{yaw=-.66;pitch=.32;zoom=1;}requestDraw();},
    zoom(factor){zoom=clamp(zoom*factor,.6,1.8);requestDraw();},
    dispose(){disposed=true;observer.disconnect();abort.abort();cancelAnimationFrame(frame);},
  };
}
