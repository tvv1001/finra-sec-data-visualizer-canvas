import re

with open('src/components/FinraGraph.tsx', 'r') as f:
    code = f.read()

# find `<div className='fg-sidebar-actions'>`
start_marker = "					<div className='fg-sidebar-actions'>"

# find `<div id='fg-sidebar-inner'`
end_marker = "					<div\n						id='fg-sidebar-inner'"

start_idx = code.find(start_marker)
end_idx = code.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("Could not find markers", start_idx, end_idx)
    exit(1)

content_to_wrap = code[start_idx:end_idx]

wrapper = """					<div className='fg-sidebar-toolbar-header' style={{ padding: '8px 8px 0', display: 'flex' }}>
						<button
							type='button'
							className={`fg-sb-toggle-btn ${isSidebarToolsOpen ? 'is-active' : ''}`}
							onClick={() => setIsSidebarToolsOpen(!isSidebarToolsOpen)}
							title={isSidebarToolsOpen ? 'Hide tools' : 'Show tools'}
							style={{ width: '100%', justifyContent: 'space-between', padding: '6px 12px', background: 'rgba(255, 255, 255, 0.96)', border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: '6px', boxShadow: '0 2px 6px rgba(15, 23, 42, 0.06)' }}>
							<span className='fg-sb-toggle-btn__label' style={{ fontWeight: 600 }}>Graph Tools</span>
							<span className='fg-sb-toggle-btn__chevron' aria-hidden='true' style={{ transform: isSidebarToolsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }}>▾</span>
						</button>
					</div>
					<div className={`fg-sidebar-toolbar-content ${isSidebarToolsOpen ? '' : 'hidden'}`}>
""" + content_to_wrap + """					</div>
"""

new_code = code[:start_idx] + wrapper + code[end_idx:]

with open('src/components/FinraGraph.tsx', 'w') as f:
    f.write(new_code)

print("Done")
