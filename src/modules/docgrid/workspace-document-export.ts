import { Document, Packer, Paragraph, TextRun, UnderlineType, ShadingType, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, LevelFormat, LineRuleType } from 'docx';
import {safeDocumentStyle} from './document-format';
import { DOCX_PAGE, DOCX_STRUCTURE_VERSION, DOCUMENT_STYLE, documentRole, documentStructureStyles, type DocumentRole } from './document-structure';
import { parseFragment, DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Context = {role?:DocumentRole;indent?:{left?:number;right?:number;firstLine?:number;hanging?:number};spacing?:{before?:number;after?:number;line?:number;lineRule?:typeof LineRuleType[keyof typeof LineRuleType]};listItem?:{used:boolean};heading?:typeof HeadingLevel[keyof typeof HeadingLevel];numbering?:{reference:string;level:number;ordered?:boolean};table?:boolean;alignment?:typeof AlignmentType[keyof typeof AlignmentType]};
type Style = {font?:string;size?:number; bold?: boolean; italics?: boolean; underline?: {type:typeof UnderlineType.SINGLE}; color?:string; shading?:{type:typeof ShadingType.CLEAR;fill:string} };
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
  let paragraphs:Array<Paragraph|Table>=[];
  const numbering:Array<{reference:string;levels:Array<{level:number;format:typeof LevelFormat[keyof typeof LevelFormat];text:string;alignment:typeof AlignmentType.LEFT;style:{paragraph:{indent:{left:number;hanging:number}}}}> }>=[];
  const listReference=(ordered:boolean)=>{const reference='list-'+numbering.length;numbering.push({reference,levels:Array.from({length:9},(_,level)=>({level,format:ordered?(level===2?LevelFormat.RUSSIAN_LOWER:LevelFormat.DECIMAL):LevelFormat.BULLET,text:ordered&&level===2?'%3)':ordered?Array.from({length:level+1},(_,i)=>'%'+(i+1)).join('.')+'.':'•',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:709*(level+1),hanging:360}}}}))});return reference;};
  if(content.startsWith(richPrefix)) {
    const fragment=parseFragment(content.slice(richPrefix.length));let runs:TextRun[]=[];
    const flush=(context:Context={})=>{const continuation=context.numbering&&context.listItem?.used;if(context.listItem)context.listItem.used=true;paragraphs.push(new Paragraph({children:runs,heading:context.heading,style:context.heading?undefined:context.table?'DocGridTable':DOCUMENT_STYLE[context.role??'body'],numbering:continuation?undefined:context.numbering,alignment:context.alignment,indent:context.indent||(context.numbering?{left:709*(context.numbering.level+1),hanging:continuation?0:360,firstLine:0}:context.heading||context.table||context.alignment===AlignmentType.CENTER||context.alignment===AlignmentType.RIGHT?{firstLine:0}:undefined),spacing:context.spacing}));runs=[];};
    const walk=(node:Node,inherited:Style={},depth=0,context:Context={})=>{
      if(depth>100)throw new Error('Слишком сложное оформление документа');
      if(node.nodeName==='#text'){if(depth===0&&!(node as DefaultTreeAdapterMap['textNode']).value.trim())return;runs.push(new TextRun({text:(node as DefaultTreeAdapterMap['textNode']).value,...inherited}));return;}
      if(!('tagName' in node))return;
      if(['script','style','iframe','object','svg','math','template'].includes(node.tagName))return;
      if(node.tagName==='table') {
        if(runs.length)flush(context);
        const output=paragraphs, rows:TableRow[]=[];
        const collectRows=(n:Node):DefaultTreeAdapterMap['element'][] => {
          if(!('tagName' in n))return [];
          if(n.tagName==='tr')return [n];
          return n.childNodes.flatMap(collectRows);
        };
        for(const row of collectRows(node)) {
          const cells:TableCell[]=[];
          for(const cell of row.childNodes) {
            if(!('tagName' in cell)||!['td','th'].includes(cell.tagName))continue;
            paragraphs=[];runs=[];
            cell.childNodes.forEach(child=>walk(child,inherited,depth+1,{table:true}));
            if(runs.length)flush({table:true});
            const span=Number(cell.attrs.find(a=>a.name==='colspan')?.value||1);
            cells.push(new TableCell({children:paragraphs.length?paragraphs:[new Paragraph('')],columnSpan:Number.isInteger(span)&&span>0&&span<=100?span:1}));
          }
          if(cells.length)rows.push(new TableRow({children:cells}));
        }
        paragraphs=output;runs=[];
        if(rows.length)paragraphs.push(new Table({rows,width:{size:100,type:WidthType.PERCENTAGE}}));
        return;
      }
      if(['ul','ol'].includes(node.tagName)){
        if(runs.length)flush(context);
        const reference=node.tagName==='ol'&&context.numbering?.ordered?context.numbering.reference:listReference(node.tagName==='ol'),level=Math.min(8,(context.numbering?.level??-1)+1);
        node.childNodes.forEach(child=>walk(child,inherited,depth+1,{...context,numbering:{reference,level,ordered:node.tagName==='ol'}}));return;
      }
      const block=['p','div','li','h1','h2','h3','h4','h5','h6'].includes(node.tagName);if(block&&runs.length)flush(context);
      const heading=/^h[1-6]$/.test(node.tagName)?(['Heading1','Heading2','Heading3','Heading4','Heading5','Heading6'] as const)[Number(node.tagName[1])-1]:context.heading;
      const textOf=(n:Node):string=>n.nodeName==='#text'?(n as DefaultTreeAdapterMap['textNode']).value:'childNodes' in n?n.childNodes.map(textOf).join(''):'';
      const next:Context={...context,heading,role:documentRole(node.attrs.find(a=>a.name==='data-dg-role')?.value,textOf(node)),...(node.tagName==='li'?{listItem:{used:false}}:{})};
      if(node.tagName==='br'){runs.push(new TextRun({break:1}));return;}
      const style={...inherited};
      if(['b','strong'].includes(node.tagName))style.bold=true;
      if(['i','em'].includes(node.tagName))style.italics=true;
      if(node.tagName==='u')style.underline={type:UnderlineType.SINGLE};
      const css=node.attrs.find(a=>a.name==='style')?.value||'';
      for(const rule of css.split(';')) {
        const [rawKey,...parts]=rule.split(':'),key=rawKey.trim();const v=safeDocumentStyle(key,parts.join(':'));
        if(v===null)continue;
        if(key==='font-family')style.font=v.replace(/^"|"$/g,'');
        if(key==='font-size')style.size=Number.parseFloat(v)*2;
        if(key==='font-weight')style.bold=/^(bold|[6-9]00)$/.test(v);
        if(key==='font-style')style.italics=v==='italic';
        if(key==='text-decoration')style.underline=v==='underline'?{type:UnderlineType.SINGLE}:undefined;
        if(key==='text-align')next.alignment=v==='justify'?AlignmentType.JUSTIFIED:v as typeof AlignmentType[keyof typeof AlignmentType];
        if(['margin-left','margin-right','text-indent'].includes(key)){
          const twips=Math.round(Number.parseFloat(v)*20);
          next.indent={...next.indent,...(key==='margin-left'?{left:twips}:key==='margin-right'?{right:twips}:twips<0?{hanging:-twips,firstLine:0}:{firstLine:twips,hanging:0})};
        }
        if(['margin-top','margin-bottom'].includes(key))next.spacing={...next.spacing,[key==='margin-top'?'before':'after']:Math.round(Number.parseFloat(v)*20)};
        if(key==='line-height')next.spacing={...next.spacing,line:Math.round(Number.parseFloat(v)*(v.endsWith('pt')?20:240)),lineRule:v.endsWith('pt')?LineRuleType.EXACT:LineRuleType.AUTO};
        const hex=color(v);
        if(key.trim()==='color'&&hex)style.color=hex;
        if(key.trim()==='background-color'&&hex)style.shading={type:ShadingType.CLEAR,fill:hex};
      }
      for(const child of node.childNodes)walk(child,style,depth+1,next);
      if(block&&(runs.length||!node.childNodes.length))flush(next);
    };
    fragment.childNodes.forEach(n=>walk(n));if(runs.length)flush();
  } else {
    for(const line of content.split('\n')) {
      const match=/^(#{1,6})\s+/.exec(line),heading=match?(['Heading1','Heading2','Heading3','Heading4','Heading5','Heading6'] as const)[match[1].length-1]:undefined,text=line.replace(/^#{1,6}\s+/,'');
      const children:TextRun[]=[];
      for(const part of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g))children.push(new TextRun({text:part.replace(/^\*{1,2}|\*{1,2}$/g,''),bold:!!heading||part.startsWith('**'),italics:part.startsWith('*')&&!part.startsWith('**')}));
      paragraphs.push(new Paragraph({children,heading,style:heading?undefined:DOCUMENT_STYLE[documentRole(undefined,text)]}));
    }
  }
  return Packer.toBuffer(new Document({title:'',description:DOCX_STRUCTURE_VERSION,numbering:{config:numbering},styles:documentStructureStyles(),sections:[{properties:{page:DOCX_PAGE},children:paragraphs.length?paragraphs:[new Paragraph({style:'DocGridBody'})]}]}));
}

export function safeDownloadName(title:string) {
  return title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'_').replace(/^\.+/,'').trim().slice(0,160)||'Документ';
}
