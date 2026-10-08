"""Apply explicit cell changes offline. XLSX package parts are retained; no formulas run."""
import sys,json,zipfile,base64,io,re
from lxml import etree as E
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
def read_xml(z,p):
 data=z.read(p)
 if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():raise ValueError('DTD forbidden')
 return E.fromstring(data,E.XMLParser(resolve_entities=False,no_network=True))
def coord(row,col):
 s=''; n=col+1
 while n:s=chr(65+(n-1)%26)+s;n=(n-1)//26
 return s+str(row+1)
source,kind,changes=sys.argv[1:4]
patches=json.load(open(changes)); output=io.BytesIO()
if kind=='xls':
 import xlrd,openpyxl
 original=xlrd.open_workbook(source); book=openpyxl.Workbook();book.remove(book.active)
 for sheet in original.sheets():
  target=book.create_sheet(sheet.name)
  for r in range(sheet.nrows):
   for c in range(sheet.ncols):
    cell=sheet.cell(r,c)
    if cell.ctype in (xlrd.XL_CELL_EMPTY,xlrd.XL_CELL_BLANK):continue
    value=cell.value
    if cell.ctype==xlrd.XL_CELL_DATE:value=xlrd.xldate_as_datetime(value,original.datemode)
    elif cell.ctype==xlrd.XL_CELL_BOOLEAN:value=bool(value)
    stored=target.cell(r+1,c+1,value)
    if cell.ctype==xlrd.XL_CELL_TEXT:stored.data_type='s'
 for p in patches:book[p['sheet']].cell(p['row']+1,p['column']+1,p['value'])
 book.save(output)
else:
 with zipfile.ZipFile(source) as z:
  if len(z.infolist())>2000 or sum(i.file_size for i in z.infolist())>32*1024*1024:raise ValueError('Expansion limit')
  workbook=read_xml(z,'xl/workbook.xml');rels={n.attrib['Id']:n.attrib['Target'] for n in read_xml(z,'xl/_rels/workbook.xml.rels') if n.attrib.get('TargetMode')!='External'}
  paths={s.attrib['name']:rels[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']] for s in workbook.iter(NS+'sheet')}
  paths={k:v.lstrip('/') if v.startswith('/') else 'xl/'+v for k,v in paths.items()}
  if any('..' in p.split('/') or p not in z.namelist() for p in paths.values()):raise ValueError('Invalid sheet')
  roots={p:read_xml(z,p) for p in paths.values()}
  for p in patches:
   root=roots[paths[p['sheet']]]; data=root.find(NS+'sheetData');r=p['row']+1;ref=coord(p['row'],p['column'])
   merged=root.find(NS+'mergeCells')
   if merged is not None:
    def indexes(reference):
     match=re.fullmatch(r'([A-Z]+)([1-9][0-9]*)',reference);column=0
     for ch in match[1]:column=column*26+ord(ch)-64
     return int(match[2])-1,column-1
    for item in merged:
     start,_,end=item.attrib['ref'].partition(':');a,b=indexes(start),indexes(end or start)
     if a[0]<=p['row']<=b[0] and a[1]<=p['column']<=b[1] and (p['row'],p['column'])!=a:raise ValueError('Edit merged cell anchor only')
   row=next((n for n in data if int(n.attrib['r'])==r),None)
   if row is None:
    row=E.Element(NS+'row',{'r':str(r)});data.append(row);data[:]=sorted(data,key=lambda n:int(n.attrib['r']))
   cell=next((n for n in row if n.attrib.get('r')==ref),None)
   if cell is None:cell=E.SubElement(row,NS+'c',{'r':ref})
   for n in list(cell):cell.remove(n)
   cell.attrib.pop('t',None);value=p['value']
   if value.startswith('='):E.SubElement(cell,NS+'f').text=value[1:]
   elif re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?',value):E.SubElement(cell,NS+'v').text=value
   else:
    cell.set('t','inlineStr');t=E.SubElement(E.SubElement(cell,NS+'is'),NS+'t');t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=value
   def col(n):
    v=0
    for ch in re.match(r'[A-Z]+',n.attrib['r'])[0]:v=v*26+ord(ch)-64
    return v
   row[:]=sorted(row,key=col)
   dimension=root.find(NS+'dimension')
   if dimension is not None:
    # Expand, never shrink, the declared range for newly inserted cells.
    previous=dimension.attrib.get('ref','A1').split(':')
    last=previous[-1];m=re.fullmatch(r'([A-Z]+)([1-9][0-9]*)',last);column=0
    if m:
     for ch in m[1]:column=column*26+ord(ch)-64
     dimension.set('ref',previous[0]+':'+coord(max(p['row'],int(m[2])-1),max(p['column'],column-1)))
  # Cached formula results are no longer trustworthy, including on other sheets.
  for root in roots.values():
   for cell in root.iter(NS+'c'):
    if cell.find(NS+'f') is not None:
     for v in list(cell.findall(NS+'v')):cell.remove(v)
  calc=workbook.find(NS+'calcPr')
  if calc is None:calc=E.SubElement(workbook,NS+'calcPr')
  calc.set('fullCalcOnLoad','1');calc.set('forceFullCalc','1');calc.set('calcMode','auto')
  replaced={p:E.tostring(root,encoding='utf-8',xml_declaration=True) for p,root in roots.items()}
  replaced['xl/workbook.xml']=E.tostring(workbook,encoding='utf-8',xml_declaration=True)
  with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as out:
   for info in z.infolist():
    out.writestr(info,replaced.get(info.filename,z.read(info.filename)))
print(base64.b64encode(output.getvalue()).decode())
