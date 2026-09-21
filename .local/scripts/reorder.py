import re

with open('src/lib/finra-graph.ts', 'r') as f:
    code = f.read()

conn_marker = "			${\n				connections.length ?"
gen_info_marker = '			<div class="fg-section-title fg-section-title--sticky">General Information</div>'
bd_marker = "      ${\n				controlConnections.length || (showFinra && staticOwnersToRender.length) ?"
end_marker = "    </div>\n  `;\n}"

conn_start = code.find(conn_marker)
gen_info_start = code.find(gen_info_marker)
bd_start = code.find(bd_marker)
end_idx = code.find(end_marker, bd_start)

if conn_start < 0 or gen_info_start < 0 or bd_start < 0 or end_idx < 0:
    print("Indices not found:")
    print(f"conn_start: {conn_start}")
    print(f"gen_info_start: {gen_info_start}")
    print(f"bd_start: {bd_start}")
    print(f"end_idx: {end_idx}")
    exit(1)

connections_block = code[conn_start:gen_info_start]
middle_block = code[gen_info_start:bd_start]
form_bd_block = code[bd_start:end_idx]

# Currently the order is:
# connections_block + middle_block + form_bd_block

# We want:
# form_bd_block + middle_block + connections_block

new_code = code[:conn_start] + form_bd_block + "\n" + middle_block + connections_block + code[end_idx:]

with open('src/lib/finra-graph.ts', 'w') as f:
    f.write(new_code)

print("Reordered successfully!")
