import re

with open("src/app/dashboard/page.tsx", "r") as f:
    content = f.read()

def repl_brochures(m):
    return """\t\t\t\t\t\t\t\t\t\t\t\t<section className={styles.detailSection}>
\t\t\t\t\t\t\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\t\t\t\t\t\t\ttype='button'
\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName={styles.detailToggleBar}
\t\t\t\t\t\t\t\t\t\t\t\t\t\tonClick={() => setDetailBrochuresOpen((open) => !open)}
\t\t\t\t\t\t\t\t\t\t\t\t\t\taria-expanded={detailBrochuresOpen}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className={styles.detailSectionTitle}>Brochures</h4>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<div className={styles.detailToggleStats}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleStat}>Count: {detailedMainRecord.brochureCards.length}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleChevron} aria-hidden='true'>{detailBrochuresOpen ? '−' : '+'}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t\t\t\t\t\t\t\t{detailBrochuresOpen && (
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<>
""" + m.group(1) + """\t\t\t\t\t\t\t\t\t\t\t\t\t\t</>
\t\t\t\t\t\t\t\t\t\t\t\t\t)}
\t\t\t\t\t\t\t\t\t\t\t\t</section>"""

pat_bro = re.compile(r"\t\t\t\t\t\t\t\t\t\t\t\t<section className=\{styles\.detailSection\}>\n\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className=\{styles\.detailSectionTitle\}>Brochures \(\{detailedMainRecord\.brochureCards\.length\}\)</h4>\n(.*?)\t\t\t\t\t\t\t\t\t\t\t\t</section>", re.DOTALL)
content = pat_bro.sub(repl_brochures, content)

def repl_notice(m):
    return """\t\t\t\t\t\t\t\t\t\t\t\t<section className={styles.detailSection}>
\t\t\t\t\t\t\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\t\t\t\t\t\t\ttype='button'
\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName={styles.detailToggleBar}
\t\t\t\t\t\t\t\t\t\t\t\t\t\tonClick={() => setDetailNoticeFilingsOpen((open) => !open)}
\t\t\t\t\t\t\t\t\t\t\t\t\t\taria-expanded={detailNoticeFilingsOpen}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className={styles.detailSectionTitle}>Notice Filings</h4>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<div className={styles.detailToggleStats}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleStat}>Count: {detailedMainRecord.noticeFilingCards.length}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleChevron} aria-hidden='true'>{detailNoticeFilingsOpen ? '−' : '+'}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t\t\t\t\t\t\t\t{detailNoticeFilingsOpen && (
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<>
""" + m.group(1) + """\t\t\t\t\t\t\t\t\t\t\t\t\t\t</>
\t\t\t\t\t\t\t\t\t\t\t\t\t)}
\t\t\t\t\t\t\t\t\t\t\t\t</section>"""

pat_not = re.compile(r"\t\t\t\t\t\t\t\t\t\t\t\t<section className=\{styles\.detailSection\}>\n\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className=\{styles\.detailSectionTitle\}>Notice Filings \(\{detailedMainRecord\.noticeFilingCards\.length\}\)</h4>\n(.*?)\t\t\t\t\t\t\t\t\t\t\t\t</section>", re.DOTALL)
content = pat_not.sub(repl_notice, content)

def repl_disc(m):
    return """\t\t\t\t\t\t\t\t\t\t\t\t<section
\t\t\t\t\t\t\t\t\t\t\t\t\tclassName={styles.detailSection}
\t\t\t\t\t\t\t\t\t\t\t\t\tstyle={{ marginTop: '12px' }}>
\t\t\t\t\t\t\t\t\t\t\t\t\t<button
\t\t\t\t\t\t\t\t\t\t\t\t\t\ttype='button'
\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName={styles.detailToggleBar}
\t\t\t\t\t\t\t\t\t\t\t\t\t\tonClick={() => setDetailDisclosuresOpen((open) => !open)}
\t\t\t\t\t\t\t\t\t\t\t\t\t\taria-expanded={detailDisclosuresOpen}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className={styles.detailSectionTitle}>Disclosures</h4>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<div className={styles.detailToggleStats}>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleStat}>Count: {detailedMainRecord.disclosureSummary.reduce((acc: number, d: any) => acc + (parseInt(d.disclosureCount) || 0), 0)}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<span className={styles.detailToggleChevron} aria-hidden='true'>{detailDisclosuresOpen ? '−' : '+'}</span>
\t\t\t\t\t\t\t\t\t\t\t\t\t</button>
\t\t\t\t\t\t\t\t\t\t\t\t\t{detailDisclosuresOpen && (
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<>
""" + m.group(1) + """\t\t\t\t\t\t\t\t\t\t\t\t\t\t</>
\t\t\t\t\t\t\t\t\t\t\t\t\t)}
\t\t\t\t\t\t\t\t\t\t\t\t</section>"""

pat_disc = re.compile(r"\t\t\t\t\t\t\t\t\t\t\t\t<section\n\t\t\t\t\t\t\t\t\t\t\t\t\tclassName=\{styles\.detailSection\}\n\t\t\t\t\t\t\t\t\t\t\t\t\tstyle=\{\{ marginTop: '12px' \}\}>\n\t\t\t\t\t\t\t\t\t\t\t\t\t<h4 className=\{styles\.detailSectionTitle\}>Disclosures</h4>\n(.*?)\t\t\t\t\t\t\t\t\t\t\t\t</section>", re.DOTALL)
content = pat_disc.sub(repl_disc, content)

with open("src/app/dashboard/page.tsx", "w") as f:
    f.write(content)

