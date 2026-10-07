/** The editable subset of Word layout. No URLs, arbitrary lengths or external fonts. */
export function safeDocumentStyle(property:string,value:string):string|null {
 const v=value.trim();
 if(['color','background-color'].includes(property)&&/^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]+)$/i.test(v))return v;
 if(property==='font-weight'&&/^(bold|normal|[1-9]00)$/.test(v))return v;
 if(property==='font-style'&&/^(italic|normal)$/.test(v))return v;
 if(property==='text-decoration'&&/^(underline|none)$/.test(v))return v;
 if(property==='text-align'&&/^(left|right|center|justify)$/.test(v))return v;
 if(property==='font-family'){
  const first=v.split(',')[0].trim().replace(/^['"]|['"]$/g,'');
  const font=['Times New Roman','Arial','Calibri','Cambria','Georgia','Verdana','Tahoma'].find(f=>f.toLowerCase()===first.toLowerCase());
  return font?'"'+font+'"':null;
 }
 const m=/^(-?\d+(?:\.\d+)?)\s*(pt|px|cm|mm)?$/.exec(v);if(!m)return null;
 let n=Number(m[1]);const unit=m[2]||'';
 if(property==='line-height'&&!unit)return n>=1&&n<=2.5?String(n):null;
 if(!unit&&n!==0)return null;
 n*=unit==='px'?0.75:unit==='cm'?72/2.54:unit==='mm'?72/25.4:1;
 const bounds:Record<string,[number,number]>={'font-size':[8,24],'margin-left':[0,360],'margin-right':[0,360],'text-indent':[-72,144],'margin-top':[0,72],'margin-bottom':[0,72],'line-height':[8,72]};
 const bound=bounds[property];return bound&&n>=bound[0]&&n<=bound[1]?String(Math.round(n*100)/100)+'pt':null;
}
