"""Bounded, offline office view. Never evaluates formulas or follows external links."""
import sys, json, zipfile, re, html, datetime
import xml.etree.ElementTree as ET

MAX_ROWS, MAX_COLS, MAX_CELLS = 2000, 100, 20000
NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def tag(n): return n.tag.rsplit('}', 1)[-1]
def esc(v): return html.escape(str(v), quote=True)
def read_xml(z, name):
    data = z.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise ValueError('DTD forbidden')
    return ET.fromstring(data)
def attr(n, key, default=''): return n.attrib.get(NS + key, default) if n is not None else default
def index(ref):
    m = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', ref)
    if not m: raise ValueError('Invalid cell reference')
    col = 0
    for c in m[1]: col = col * 26 + ord(c) - 64
    return int(m[2]) - 1, col - 1

def docx_view(z):
    root = read_xml(z, 'word/document.xml')
    body = root.find(NS + 'body')
    warnings = set()
    def number(value, scale=1, low=0, high=72):
        try:
            n=float(value)/scale
            return format(n,'.2f').rstrip('0').rstrip('.') if low <= n <= high else None
        except (ValueError, TypeError): return None
    def run_css(props):
        css={}
        if props is None: return css
        for name, key, on, off in [('b','font-weight','bold','normal'),('i','font-style','italic','normal')]:
            item=props.find(NS+name)
            if item is not None: css[key]=off if attr(item,'val','1') in ('0','false','off') else on
        u=props.find(NS+'u')
        if u is not None: css['text-decoration']='none' if attr(u,'val','single')=='none' else 'underline'
        font=attr(props.find(NS+'rFonts'),'ascii') or attr(props.find(NS+'rFonts'),'hAnsi')
        if font in ('Times New Roman','Arial','Calibri','Cambria','Georgia','Verdana','Tahoma'): css['font-family']="'"+font+"'"
        size=number(attr(props.find(NS+'sz'),'val'),2,8,24)
        if size is not None: css['font-size']=size+'pt'
        color=attr(props.find(NS+'color'),'val')
        if re.fullmatch('[a-fA-F0-9]{6}',color): css['color']='#'+color
        mark=attr(props.find(NS+'highlight'),'val')
        palette={'yellow':'ffff00','green':'00ff00','cyan':'00ffff','magenta':'ff00ff','blue':'0000ff','red':'ff0000','lightGray':'d3d3d3'}
        fill=palette.get(mark) or attr(props.find(NS+'shd'),'fill')
        if re.fullmatch('[a-fA-F0-9]{6}',fill): css['background-color']='#'+fill
        return css
    def paragraph_css(props):
        css={}
        if props is None: return css
        align=attr(props.find(NS+'jc'),'val')
        if align=='both': align='justify'
        if align in ('left','right','center','justify'): css['text-align']=align
        ind=props.find(NS+'ind')
        for name,key,low,high in [('left','margin-left',0,360),('right','margin-right',0,360),('firstLine','text-indent',-72,144),('hanging','text-indent',0,72)]:
            value=number(attr(ind,name),20,low,high)
            if value is not None: css[key]=('-' if name=='hanging' and value!='0' else '')+value+'pt'
        spacing=props.find(NS+'spacing')
        for name,key in [('before','margin-top'),('after','margin-bottom')]:
            value=number(attr(spacing,name),20,0,72)
            if value is not None: css[key]=value+'pt'
        line=attr(spacing,'line')
        if line:
            auto=attr(spacing,'lineRule','auto')=='auto'
            value=number(line,240 if auto else 20,1 if auto else 8,2.5 if auto else 72)
            if value is not None: css['line-height']=value if auto else value+'pt'
        return css
    defaults_p, defaults_r, styles, default_style = {}, {}, {}, ''
    if 'word/styles.xml' in z.namelist():
        source=read_xml(z,'word/styles.xml')
        defaults=source.find(NS+'docDefaults')
        if defaults is not None:
            defaults_p=paragraph_css(defaults.find(NS+'pPrDefault/'+NS+'pPr'))
            defaults_r=run_css(defaults.find(NS+'rPrDefault/'+NS+'rPr'))
        for style in source.findall(NS+'style'):
            sid=attr(style,'styleId'); styles[sid]=style
            if attr(style,'type')=='paragraph' and attr(style,'default')=='1': default_style=sid
    def resolved(sid, depth=0, trail=()):
        if not sid or sid not in styles or depth>=12 or sid in trail: return {}, {}, None
        st=styles[sid]; pc, rc, outline=resolved(attr(st.find(NS+'basedOn'),'val'),depth+1,trail+(sid,))
        pc.update(paragraph_css(st.find(NS+'pPr'))); rc.update(run_css(st.find(NS+'rPr')))
        level=st.find(NS+'pPr/'+NS+'outlineLvl')
        if level is not None: outline=attr(level,'val')
        return pc,rc,outline
    def css_attr(css):
        return ' style="'+esc(';'.join(k+':'+v for k,v in css.items()))+'"' if css else ''
    def paragraph(p):
        props=p.find(NS+'pPr'); sid=attr(props.find(NS+'pStyle') if props is not None else None,'val') or default_style
        pc,rc,outline=resolved(sid)
        pc={**defaults_p,**pc,**paragraph_css(props)}; rc={**defaults_r,**rc}
        direct_outline=props.find(NS+'outlineLvl') if props is not None else None
        if direct_outline is not None: outline=attr(direct_outline,'val')
        name='h'+str(int(outline)+1) if outline is not None and outline in ('0','1','2','3','4','5') else 'p'
        out=[]
        for r in p.iter(NS+'r'):
            direct=r.find(NS+'rPr'); csid=attr(direct.find(NS+'rStyle') if direct is not None else None,'val')
            _,char,_=resolved(csid)
            css={**char,**run_css(direct)}
            text=''.join(esc(n.text or '') if tag(n)=='t' else '\t' if tag(n)=='tab' else '<br>' if tag(n) in ('br','cr') else '' for n in r)
            out.append('<span'+css_attr(css)+'>'+text+'</span>' if css else text)
        return '<'+name+css_attr({**rc,**pc})+'>'+''.join(out)+'</'+name+'>'
    def block(n):
        if tag(n)=='p': return paragraph(n)
        if tag(n)=='tbl':
            rows=[]
            for tr in n.findall(NS+'tr'):
                cells=[]
                for tc in tr.findall(NS+'tc'):
                    props=tc.find(NS+'tcPr')
                    span=attr(props.find(NS+'gridSpan') if props is not None else None,'val','1')
                    span=span if span.isdigit() and 1 <= int(span) <= 100 else '1'
                    if props is not None and props.find(NS+'vMerge') is not None: warnings.add('Вертикальное объединение ячеек упрощено.')
                    cells.append('<td colspan="'+span+'">'+''.join(block(c) for c in tc)+'</td>')
                rows.append('<tr>'+''.join(cells)+'</tr>')
            return '<table><tbody>'+''.join(rows)+'</tbody></table>'
        if tag(n) in ('sdt','sdtContent'): return ''.join(block(c) for c in n)
        return ''
    for n in root.iter():
        if tag(n) in ('drawing','pict','object'): warnings.add('Изображения и встроенные объекты остаются в исходном файле.')
        if tag(n) in ('numPr','pStyle'): warnings.add('Автоматическая нумерация и сложные стили Word могут отличаться.')
        if tag(n) in ('ins','del','fldChar','instrText'): warnings.add('Поля и история исправлений Word не переносятся.')
    warnings.add('Разметка страниц, колонтитулы и сложные стили остаются в исходном файле.')
    content = ''.join(block(n) for n in body)
    if len(content)>800000: raise ValueError('Document size limit')
    return {'kind':'docx','html':content,'warnings':sorted(warnings)}

def xlsx_view(z):
    names=z.namelist()
    shared=[''.join(n.text or '' for n in s.iter() if tag(n)=='t') for s in read_xml(z,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in names else []
    rels={x.attrib['Id']:x.attrib['Target'] for x in read_xml(z,'xl/_rels/workbook.xml.rels') if x.attrib.get('TargetMode')!='External'}
    result=[]
    sheets=[s for s in read_xml(z,'xl/workbook.xml').iter() if tag(s)=='sheet']
    for sheet in sheets[:50]:
        target=rels.get(sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'),'')
        target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
        if '..' in target.split('/') or target not in names: raise ValueError('Unknown worksheet')
        rows, total, partial = {}, 0, False
        for cell in read_xml(z,target).iter():
            if tag(cell)!='c': continue
            row,col=index(cell.attrib.get('r',''))
            if row>=MAX_ROWS or col>=MAX_COLS or total>=MAX_CELLS: partial=True; continue
            value=next((n.text or '' for n in cell if tag(n)=='v'),'')
            typ=cell.attrib.get('t')
            if typ=='s': value=shared[int(value)]
            elif typ=='inlineStr': value=''.join(n.text or '' for n in cell.iter() if tag(n)=='t')
            elif typ=='b': value='TRUE' if value=='1' else 'FALSE'
            formula=next((n.text or '' for n in cell if tag(n)=='f'),None)
            if formula is not None and not value: value='[нет сохранённого результата]'
            if value or formula is not None:
                rows.setdefault(row,[]).append({'column':col,'value':value[:10000],'formula':formula[:10000] if formula is not None else None})
                total+=1
        result.append({'name':sheet.attrib.get('name','Лист'),'rows':[{'index':r,'cells':c} for r,c in sorted(rows.items())], 'partial':partial})
    return {'kind':'spreadsheet','sheets':result,'warnings':['Показаны сохранённые значения. Формулы не пересчитываются. Даты могут отображаться числовыми значениями Excel.']+(['Показаны первые 50 листов.'] if len(sheets)>50 else [])}

def xls_view(path):
    import xlrd
    book=xlrd.open_workbook(path,on_demand=True)
    result=[]
    try:
        for s in book.sheets()[:50]:
            rows=[]; count=0; partial=s.nrows>MAX_ROWS or s.ncols>MAX_COLS
            for r in range(min(s.nrows,MAX_ROWS)):
                cells=[]
                for c in range(min(s.ncols,MAX_COLS)):
                    cell=s.cell(r,c)
                    if cell.ctype in (xlrd.XL_CELL_EMPTY,xlrd.XL_CELL_BLANK): continue
                    if count>=MAX_CELLS: partial=True; break
                    value=cell.value
                    if cell.ctype==xlrd.XL_CELL_DATE:
                        try: value=xlrd.xldate_as_datetime(value,book.datemode).isoformat(sep=' ')
                        except ValueError: pass
                    cells.append({'column':c,'value':str(value)[:10000],'formula':None}); count+=1
                if cells: rows.append({'index':r,'cells':cells})
            result.append({'name':s.name,'rows':rows,'partial':partial})
    finally: book.release_resources()
    return {'kind':'spreadsheet','sheets':result,'warnings':['Показаны сохранённые значения. Формулы не пересчитываются.']}

if __name__=='__main__':
    path,kind=sys.argv[1:3]
    if kind=='xls': result=xls_view(path)
    else:
        with zipfile.ZipFile(path) as z:
            infos=z.infolist()
            if len(infos)>2000 or sum(i.file_size for i in infos)>32*1024*1024: raise ValueError('Archive expansion limit')
            result=docx_view(z) if kind=='docx' else xlsx_view(z)
    print(json.dumps(result,ensure_ascii=False))
