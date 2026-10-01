import { Document, Packer, Paragraph, TextRun, UnderlineType, ShadingType } from 'docx';
import { parseFragment, DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Style = { bold?: boolean; italics?: boolean; underline?: {type:typeof UnderlineType.SINGLE}; color?:string; shading?:{type:typeof ShadingType.CLEAR;fill:string} };
const richPrefix='<!-- docgrid-richtext-v1 -->';
function color(value:string):string|undefined {
  const v=value.trim();
  if(/^#[a-f0-9]{6}$/i.test(v))return v.slice(1);
  if(/^#[a-f0-9]{3}$/i.test(v))return v.slice(1).split('').map(c=>c+c).join('');
  const rgb=/^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$/i.exec(v);
  if(rgb&&rgb.slice(1).every(n=>Number(n)<=255))return rgb.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join('');
  return ({black:'000000',white:'FFFFFF',red:'FF0000',yellow:'FFFF00',blue:'0000FF',green:'008000'} as Record<string,string>)[v.toLowerCase()];
}

// Parse stored editor content, never execute it or import external resources.
export async function renderWorkspaceDocx(content:string):Promise<Buffer> {
  const paragraphs:Paragraph[]=[];
  if(content.startsWith(richPrefix)) {
    const fragment=parseFragment(content.slice(richPrefix.length));let runs:TextRun[]=[];
    const flush=()=>{paragraphs.push(new Paragraph({children:runs,spacing:{after:120,line:360}}));runs=[];};
    const walk=(node:Node,inherited:Style={},depth=0)=>{
      if(depth>100)throw new Error('Слишком сложное оформление документа');
      if(node.nodeName==='#text'){runs.push(new TextRun({text:(node as DefaultTreeAdapterMap['textNode']).value,...inherited}));return;}
      if(!('tagName' in node))return;
      if(['script','style','iframe','object','svg','math','template'].includes(node.tagName))return;
      const block=['p','div'].includes(node.tagName);if(block&&runs.length)flush();
      if(node.tagName==='br'){runs.push(new TextRun({break:1}));return;}
      const style={...inherited};
      if(['b','strong'].includes(node.tagName))style.bold=true;
      if(['i','em'].includes(node.tagName))style.italics=true;
      if(node.tagName==='u')style.underline={type:UnderlineType.SINGLE};
      const css=node.attrs.find(a=>a.name==='style')?.value||'';
      for(const rule of css.split(';')) {
        const [key,...parts]=rule.split(':');const v=parts.join(':').trim();
        if(key.trim()==='font-weight')style.bold=/^(bold|[6-9]00)$/.test(v);
        if(key.trim()==='font-style')style.italics=v==='italic';
        if(key.trim()==='text-decoration'&&v.includes('underline'))style.underline={type:UnderlineType.SINGLE};
        const hex=color(v);
        if(key.trim()==='color'&&hex)style.color=hex;
        if(key.trim()==='background-color'&&hex)style.shading={type:ShadingType.CLEAR,fill:hex};
      }
      for(const child of node.childNodes)walk(child,style,depth+1);
      if(block)flush();
    };
    fragment.childNodes.forEach(n=>walk(n));if(runs.length)flush();
  } else {
    for(const line of content.split('\n')) {
      const heading=/^#{1,6}\s/.test(line),text=line.replace(/^#{1,6}\s+/,'');
      const children:TextRun[]=[];
      for(const part of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g))children.push(new TextRun({text:part.replace(/^\*{1,2}|\*{1,2}$/g,''),bold:heading||part.startsWith('**'),italics:part.startsWith('*')&&!part.startsWith('**')}));
      paragraphs.push(new Paragraph({children,spacing:{after:120,line:360}}));
    }
  }
  return Packer.toBuffer(new Document({styles:{default:{document:{run:{font:'Times New Roman',size:24}}}},sections:[{properties:{page:{margin:{top:1134,bottom:1134,left:1701,right:850}}},children:paragraphs.length?paragraphs:[new Paragraph('')]}]}));
}

export function safeDownloadName(title:string) {
  return title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'_').replace(/^\.+/,'').trim().slice(0,160)||'Документ';
}
