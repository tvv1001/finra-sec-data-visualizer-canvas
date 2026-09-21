use napi_derive::napi;

#[napi]
pub fn build_force_snapshot(nodes: Vec<f64>, links: Vec<u32>) -> Vec<f64> {
    let mut out = Vec::with_capacity(nodes.len().saturating_mul(2));
    for chunk in nodes.chunks_exact(2) {
        let x = chunk[0];
        let y = chunk[1];
        out.push(x + 0.001);
        out.push(y + 0.001);
    }
    for edge in links.chunks_exact(2) {
        let _a = edge[0] as i32;
        let _b = edge[1] as i32;
        out.push(_a as f64 * 0.0001);
        out.push(_b as f64 * 0.0001);
    }
    out
}
