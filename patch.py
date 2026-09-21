import sys

def patch():
    with open("src/app/dashboard/page.tsx", "r") as f:
        content = f.read()
    
    # 1. newCrdsOpen hook
    old_effect = """\t// Collapse the New CRDs panel by default on mobile viewports (desktop stays open); runs once
\t// after mount so it doesn't affect SSR/hydration.
\tuseEffect(() => {
\t\tif (typeof window === 'undefined') return;
\t\tif (window.innerWidth <= 720) setNewCrdsOpen(false);
\t}, []);"""
    new_effect = """\t// Collapse the New CRDs panel by default on tablet/mobile viewports; runs once
\t// after mount. It also listens to resize events to auto-toggle unless explicitly overridden.
\tconst toggleNewCrdsOpen = useCallback(() => {
\t\tsetNewCrdsOpen((prev) => {
\t\t\tconst next = !prev;
\t\t\tlocalStorage.setItem('finra_new_crds_state', next ? 'open' : 'closed');
\t\t\treturn next;
\t\t});
\t}, []);

\tuseEffect(() => {
\t\tif (typeof window === 'undefined') return;
\t\tconst stored = localStorage.getItem('finra_new_crds_state');
\t\tif (stored === 'open') {
\t\t\tsetNewCrdsOpen(true);
\t\t} else if (stored === 'closed') {
\t\t\tsetNewCrdsOpen(false);
\t\t} else {
\t\t\tif (window.innerWidth <= 1280) setNewCrdsOpen(false);
\t\t}

\t\tconst handleResize = () => {
\t\t\tif (localStorage.getItem('finra_new_crds_state')) return; // Explicit choice overrides responsive
\t\t\tsetNewCrdsOpen(window.innerWidth > 1280);
\t\t};

\t\twindow.addEventListener('resize', handleResize);
\t\treturn () => window.removeEventListener('resize', handleResize);
\t}, []);"""
    content = content.replace(old_effect, new_effect)
    content = content.replace("onClick={() => setNewCrdsOpen((open) => !open)}", "onClick={toggleNewCrdsOpen}")

    # 2. Add state toggles
    old_state = "\tconst [detailCollectionsOpen, setDetailCollectionsOpen] = useState(false);"
    new_state = """\tconst [detailCollectionsOpen, setDetailCollectionsOpen] = useState(false);
\tconst [detailDisclosuresOpen, setDetailDisclosuresOpen] = useState(false);
\tconst [detailBrochuresOpen, setDetailBrochuresOpen] = useState(false);
\tconst [detailNoticeFilingsOpen, setDetailNoticeFilingsOpen] = useState(false);"""
    content = content.replace(old_state, new_state)

    # 3. set default open for toggles
    old_col = "\t\tsetDetailCollectionsOpen(true);"
    new_col = """\t\tsetDetailCollectionsOpen(false);
\t\tsetDetailDisclosuresOpen(false);
\t\tsetDetailBrochuresOpen(false);
\t\tsetDetailNoticeFilingsOpen(false);"""
    content = content.replace(old_col, new_col)

    with open("src/app/dashboard/page.tsx", "w") as f:
        f.write(content)

patch()
