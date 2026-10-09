"""Bounded local HTML text extraction; no DOM, scripts, external resources or browser."""
import json
import sys
from html.parser import HTMLParser

LIMIT = 200_000

class Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.length = 0
        self.partial = False
        self.hidden = []
        self.excluded = {'script', 'style', 'head', 'iframe', 'object', 'svg', 'math', 'template'}
        self.blocks = {'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table', 'ul', 'ol'}

    def emit(self, value):
        if self.length + len(value) > LIMIT:
            self.partial = True
        value = value[:max(0, LIMIT-self.length)]
        self.parts.append(value)
        self.length += len(value)

    def handle_starttag(self, tag, attrs):
        # Track excluded descendants too: closing an inner element must not
        # expose text that is still inside an excluded ancestor.
        if tag in self.excluded:
            self.hidden.append(tag)
        elif not self.hidden and (tag in self.blocks or tag == 'br'):
            self.emit('\n')

    def handle_endtag(self, tag):
        if self.hidden:
            # Unmatched closing tags cannot release an excluded ancestor.
            if tag == self.hidden[-1]:
                self.hidden.pop()
        elif tag in self.blocks:
            self.emit('\n')
        elif tag in {'td', 'th'}:
            self.emit('\t')

    def handle_data(self, data):
        if not self.hidden:
            self.emit(data)

reader = Reader()
with open(sys.argv[1], encoding='utf-8', errors='strict') as source:
    while chunk := source.read(64*1024):
        reader.feed(chunk)
reader.close()
print(json.dumps({'text': ''.join(reader.parts).strip(), 'partial': reader.partial}, ensure_ascii=False))
