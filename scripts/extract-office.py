"""Read office text without executing macros, following links, or extracting ZIP paths."""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

LIMIT = 200_000
parts = []
length = 0
partial = False

def emit(value):
    global length, partial
    if length >= LIMIT:
        partial = True
        return
    value = str(value)
    if length + len(value) > LIMIT:
        partial = True
    value = value[:LIMIT-length]
    parts.append(value)
    length += len(value)

def xml(z, name):
    data = z.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD not allowed')
    return ET.fromstring(data)

def tag(node):
    return node.tag.rsplit('}', 1)[-1]

path, kind = sys.argv[1:3]
if kind == 'xls':
    import xlrd
    book = xlrd.open_workbook(path, on_demand=True)
    for sheet in book.sheets():
        emit('\n' + sheet.name + '\n')
        for row in sheet.get_rows():
            emit('\t'.join(str(c.value) for c in row) + '\n')
            if length >= LIMIT:
                partial = True
                break
    book.release_resources()
else:
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if len(infos) > 2000 or sum(i.file_size for i in infos) > 32*1024*1024:
            raise ValueError('Archive expansion limit')
        names = z.namelist()
        if kind == 'docx':
            ordered = ['word/document.xml'] + sorted(n for n in names if n.startswith('word/') and n.endswith('.xml') and n.split('/')[-1].startswith(('header', 'footer', 'footnotes', 'endnotes')))
            for name in ordered:
                for p in xml(z, name).iter():
                    if tag(p) == 'p':
                        emit(''.join((n.text or '') if tag(n) == 't' else '\t' if tag(n) == 'tab' else '\n' if tag(n) in ('br', 'cr') else '' for n in p.iter()) + '\n')
        elif kind == 'odt':
            for p in xml(z, 'content.xml').iter():
                if tag(p) in ('p', 'h'):
                    emit(''.join(p.itertext()) + '\n')
        elif kind == 'xlsx':
            shared = []
            if 'xl/sharedStrings.xml' in names:
                shared = [''.join(n.text or '' for n in item.iter() if tag(n) == 't') for item in xml(z, 'xl/sharedStrings.xml')]
            rels = {x.attrib['Id']:x.attrib['Target'] for x in xml(z, 'xl/_rels/workbook.xml.rels') if x.attrib.get('TargetMode') != 'External'}
            for sheet in xml(z, 'xl/workbook.xml').iter():
                if tag(sheet) != 'sheet':
                    continue
                rid = sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                target = rels.get(rid, '')
                target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
                if '..' in target.split('/') or target not in names:
                    raise ValueError('Unknown worksheet')
                emit('\n' + sheet.attrib.get('name', 'Лист') + '\n')
                for row in xml(z, target).iter():
                    if tag(row) != 'row':
                        continue
                    cells = []
                    for cell in row:
                        value = ''.join(n.text or '' for n in cell if tag(n) == 'v')
                        if cell.attrib.get('t') == 's':
                            value = shared[int(value)]
                        elif cell.attrib.get('t') == 'inlineStr':
                            value = ''.join(n.text or '' for n in cell.iter() if tag(n) == 't')
                        if any(tag(n) == 'f' for n in cell) and not value:
                            value = '[формула без сохранённого результата]'
                            partial = True
                        if value:
                            cells.append(cell.attrib.get('r', '') + ': ' + value)
                    emit(' | '.join(cells) + '\n')
                    if length >= LIMIT:
                        partial = True
                        break
        else:
            raise ValueError('Unsupported office file')
print(json.dumps({'text': ''.join(parts), 'partial': partial}, ensure_ascii=False))
