import sys

with open('app/main.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if line.strip().startswith('suggestions.append('):
        lines[i] = '                suggestions.append(\n'
        break

with open('app/main.py', 'w', encoding='utf-8') as f:
    f.writelines(lines)
