import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('./figures/', import.meta.url));
mkdirSync(folder, { recursive: true });
const ink = '#192b42', slate = '#496077', grid = '#dce4ed';
const palette = ['#173f75', '#168385', '#c47824'];
const esc = (label) => String(label).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (x, y, label, { size = 22, color = ink, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(label)}</text>`;
const rect = (x, y, w, h, color, rx = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${color}"/>`;
const line = (x1, y1, x2, y2, color = grid, width = 1) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"/>`;
const save = (file, width, height, body) => writeFileSync(join(folder, `${file}.svg`),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rect(0,0,width,height,'white')}<g font-family="DejaVu Sans, sans-serif">${body}</g></svg>\n`);

const card = (x, y, w, h, heading, lines, color) =>
  rect(x,y,w,h,color,9) + text(x+15,y+27,heading,{size:22,weight:700}) +
  lines.map((label,i)=>text(x+15,y+53+i*24,label,{size:17,color:slate})).join('');
const arrow = (x1,y1,x2,y2) => line(x1,y1,x2,y2,slate,2) + (x1 === x2
  ? `<path d="M ${x2-5} ${y2-8} L ${x2} ${y2} L ${x2+5} ${y2-8}" fill="none" stroke="${slate}" stroke-width="2"/>`
  : `<path d="M ${x2-8} ${y2-5} L ${x2} ${y2} L ${x2-8} ${y2+5}" fill="none" stroke="${slate}" stroke-width="2"/>`);
let architecture = text(18,27,'STAGE 1  ·  BUILD THE EVIDENCE LIBRARY',{size:17,weight:700,color:palette[0]});
architecture += card(18,43,206,90,'Plan',['Question → evidence','needs and queries'],'#e9f2fb');
architecture += card(249,43,220,90,'Discover & read',['Search → select URLs','Custom crawler / Pi fetch'],'#e9f2fb');
architecture += card(494,43,219,90,'Retrieve & inspect',['BM25 + MMR; read','exact source spans'],'#e9f2fb');
architecture += card(738,43,206,90,'Assess',['Judge essential needs','and evidence gaps'],'#e9f2fb');
for (const x of [224,469,713]) architecture += arrow(x,87,x+23,87);
architecture += `<path d="M 841 133 V 163 H 359 V 139" fill="none" stroke="${slate}" stroke-width="2"/>`;
architecture += `<path d="M 354 147 L 359 139 L 364 147" fill="none" stroke="${slate}" stroke-width="2"/>`;
architecture += rect(483,152,250,23,'white')+text(608,169,'Essential gap → new search',{size:16,anchor:'middle',color:slate});
architecture += text(18,207,'STAGE 2  ·  SYNTHESIZE FROM SAVED EVIDENCE',{size:17,weight:700,color:palette[1]});
architecture += card(18,223,276,88,'Save the library',['Sources, ranked passages,','inspection records and gaps'],'#e9f5f4');
architecture += card(340,223,276,88,'Write the report',['Synthesize saved evidence;','cite passage and inspection IDs'],'#e9f5f4');
architecture += card(662,223,282,88,'Resolve citations',['Link claims to stored source','text and exact offsets'],'#e9f5f4');
architecture += arrow(294,269,338,269)+arrow(616,269,660,269);
architecture += `<path d="M 928 133 V 189 H 171 V 221" fill="none" stroke="${slate}" stroke-width="2"/>`;
architecture += `<path d="M 166 213 L 171 221 L 176 213" fill="none" stroke="${slate}" stroke-width="2"/>`;
architecture += rect(595,177,275,23,'white')+text(732,193,'Sufficient evidence or finish request',{size:15,anchor:'middle',color:slate});
save('workflow',960,327,architecture);

const reports = [
  { label:'Task 19 · Prometheus', rows:[['Project',94.29],['OpenAI Deep Research',77.69],['drsh',76.87],['Perplexity',49.07]] },
  { label:'Task 20 · Streamable HTTP', rows:[['Project',83.04],['OpenAI Deep Research',79.08],['Grok',58.53],['drsh',51.96]] },
];
let race = '';
for (const [panel,{label,rows}] of reports.entries()) {
  const base=panel*478, left=base+159, span=275;
  race += text(base+22,34,label,{size:22,weight:700});
  for (const tick of [0,25,50,75,100]) {
    const x=left+span*tick/100;
    race += line(x,50,x,221)+text(x,245,tick,{size:15,color:slate,anchor:'middle'});
  }
  rows.forEach(([method,value],index)=>{
    const y=62+index*42;
    race += text(left-10,y+18,method,{size:14,anchor:'end',weight:index===0?700:400});
    race += rect(left,y,span*value/100,24,index===0?palette[0]:'#a3b4c6',3);
    race += text(left+span*value/100-6,y+17,value.toFixed(2),{size:14,weight:700,anchor:'end',color:index===0?'white':ink});
  });
  race += text(left+span/2,271,'Point-wise RACE score / 100',{size:16,color:slate,anchor:'middle'});
}
save('race-scores',960,284,race);

const retrieval = [
  ['Whole document',[2.51,9.50,28.25],[3.50,15.48,35.93]],
  ['Passage',[5.87,21.32,46.24],[7.36,26.75,50.55]],
  ['Stemmed passage',[5.21,22.37,45.70],[8.69,28.39,47.86]],
];
let recall='';
retrieval.forEach(([label],i)=>{
  const x=53+i*295;
  recall+=rect(x,5,20,14,palette[i],2)+text(x+28,18,label,{size:18});
});
for (const panel of [0,1]) {
  const base=panel*478,left=base+61,top=69,bottom=224, plotW=368;
  recall+=text(left,50,panel?'Gold judgments':'Evidence judgments',{size:21,weight:700});
  for(const tick of [0,10,20,30,40,50]) {
    const y=bottom-tick/55*(bottom-top);
    recall+=line(left,y,left+plotW,y)+text(left-9,y+5,`${tick}%`,{size:15,color:slate,anchor:'end'});
  }
  for(const [i,k] of [5,100,1000].entries()){
    const center=left+plotW*(i+0.5)/3;
    for(const [m,row] of retrieval.entries()){
      const value=row[panel+1][i], height=value/55*(bottom-top), x=center-37+25*m;
      recall+=rect(x,bottom-height,22,height,palette[m],2);
    }
    recall+=text(center,249,`@${k}`,{size:16,color:slate,anchor:'middle'});
  }
  recall+=text(left+plotW/2,273,'Recall at rank cutoff',{size:16,color:slate,anchor:'middle'});
}
save('browsecomp-recall',960,286,recall);
