use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
struct QuadNode {
    cx: f64,
    cy: f64,
    size: f64,
    mass_x: f64,
    mass_y: f64,
    mass: f64,
    children: [usize; 4],
    body: Option<usize>,
}

#[wasm_bindgen]
pub struct GraphSimulation {
    positions: Vec<f64>,
    velocities: Vec<f64>,
    r: Vec<f64>,
    loc_strength: Vec<f64>,
    loc_x: Vec<f64>,
    loc_y: Vec<f64>,
    source_indices: Vec<usize>,
    target_indices: Vec<usize>,
    width: f64,
    height: f64,
}

#[wasm_bindgen]
impl GraphSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new(width: f64, height: f64) -> GraphSimulation {
        GraphSimulation {
            positions: Vec::new(),
            velocities: Vec::new(),
            r: Vec::new(),
            loc_strength: Vec::new(),
            loc_x: Vec::new(),
            loc_y: Vec::new(),
            source_indices: Vec::new(),
            target_indices: Vec::new(),
            width,
            height,
        }
    }

    pub fn add_node(&mut self, x: f64, y: f64, r: f64, loc_strength: f64, loc_x: f64, loc_y: f64) {
        self.positions.push(x);
        self.positions.push(y);
        self.velocities.push(0.0);
        self.velocities.push(0.0);
        self.r.push(r);
        self.loc_strength.push(loc_strength);
        self.loc_x.push(loc_x);
        self.loc_y.push(loc_y);
    }

    pub fn add_link(&mut self, source: usize, target: usize) {
        self.source_indices.push(source);
        self.target_indices.push(target);
    }

    pub fn update_node(&mut self, index: usize, x: f64, y: f64) {
        if index * 2 + 1 < self.positions.len() {
            self.positions[index * 2] = x;
            self.positions[index * 2 + 1] = y;
        }
    }
    
    pub fn update_size(&mut self, width: f64, height: f64) {
        self.width = width;
        self.height = height;
    }

    pub fn tick(&mut self, iterations: usize) {
        let n = self.r.len();
        if n == 0 { return; }

        let desired_link_length = 70.0;
        let link_strength = 0.015;
        let repulsion_strength = 1800.0;
        let damping = 0.86;
        let theta2 = 0.81; // theta=0.9 squared

        for _ in 0..iterations {
            let mut fx = vec![0.0; n];
            let mut fy = vec![0.0; n];

            // 1. Build Quadtree
            let mut min_x = self.positions[0];
            let mut max_x = self.positions[0];
            let mut min_y = self.positions[1];
            let mut max_y = self.positions[1];
            
            for i in 1..n {
                let x = self.positions[i * 2];
                let y = self.positions[i * 2 + 1];
                if x < min_x { min_x = x; }
                if x > max_x { max_x = x; }
                if y < min_y { min_y = y; }
                if y > max_y { max_y = y; }
            }
            
            let dx = max_x - min_x;
            let dy = max_y - min_y;
            let size = if dx > dy { dx } else { dy }.max(1.0);
            let cx = min_x + size / 2.0;
            let cy = min_y + size / 2.0;
            
            let mut arena = Vec::with_capacity(n * 2 + 100);
            arena.push(QuadNode {
                cx, cy, size, mass_x: 0.0, mass_y: 0.0, mass: 0.0, children: [0; 4], body: None
            });
            
            for i in 0..n {
                let mut node_idx = 0;
                let body = i;
                let bx = self.positions[i * 2];
                let by = self.positions[i * 2 + 1];
                let bmass = 1.0;
                let mut depth = 0;
                
                loop {
                    depth += 1;
                    let node = &mut arena[node_idx];
                    node.mass_x = (node.mass_x * node.mass + bx * bmass) / (node.mass + bmass);
                    node.mass_y = (node.mass_y * node.mass + by * bmass) / (node.mass + bmass);
                    node.mass += bmass;
                    
                    let has_children = node.children[0] != 0 || node.children[1] != 0 || node.children[2] != 0 || node.children[3] != 0;
                    
                    if !has_children && node.body.is_none() {
                        node.body = Some(body);
                        break;
                    }
                    
                    if !has_children {
                        let existing_body = node.body.take().unwrap();
                        let mut ex = self.positions[existing_body * 2];
                        let mut ey = self.positions[existing_body * 2 + 1];
                        
                        let cx = node.cx;
                        let cy = node.cy;
                        let size = node.size;
                        
                        if depth > 30 {
                            ex += 1e-1;
                            ey += 1e-1;
                        }
                        
                        let q_existing = (if ex > cx { 1 } else { 0 }) + (if ey > cy { 2 } else { 0 });
                        let ncx = cx + if q_existing % 2 == 1 { size / 4.0 } else { -size / 4.0 };
                        let ncy = cy + if q_existing >= 2 { size / 4.0 } else { -size / 4.0 };
                        
                        let child_idx = arena.len();
                        arena.push(QuadNode {
                            cx: ncx, cy: ncy, size: size / 2.0,
                            mass_x: ex, mass_y: ey, mass: 1.0,
                            children: [0; 4], body: Some(existing_body)
                        });
                        arena[node_idx].children[q_existing] = child_idx;
                    }
                    
                    let cx = arena[node_idx].cx;
                    let cy = arena[node_idx].cy;
                    let size = arena[node_idx].size;
                    let mut quad = (if bx > cx { 1 } else { 0 }) + (if by > cy { 2 } else { 0 });
                    
                    if depth > 30 && arena[node_idx].children[quad] != 0 {
                         let mut found = false;
                         for q in 0..4 {
                             if arena[node_idx].children[q] == 0 {
                                 quad = q;
                                 found = true;
                                 break;
                             }
                         }
                         if !found { break; }
                    }
                    
                    if arena[node_idx].children[quad] == 0 {
                        let ncx = cx + if quad % 2 == 1 { size / 4.0 } else { -size / 4.0 };
                        let ncy = cy + if quad >= 2 { size / 4.0 } else { -size / 4.0 };
                        let child_idx = arena.len();
                        arena.push(QuadNode {
                            cx: ncx, cy: ncy, size: size / 2.0,
                            mass_x: 0.0, mass_y: 0.0, mass: 0.0,
                            children: [0; 4], body: None
                        });
                        arena[node_idx].children[quad] = child_idx;
                    }
                    
                    node_idx = arena[node_idx].children[quad];
                }
            }

            // 2. Barnes-Hut Repulsion Force Calculation
            for i in 0..n {
                let bx = self.positions[i * 2];
                let by = self.positions[i * 2 + 1];
                let br = self.r[i];
                
                let mut stack = vec![0];
                
                while let Some(curr) = stack.pop() {
                    let node = &arena[curr];
                    let dx = bx - node.mass_x;
                    let dy = by - node.mass_y;
                    let dist2 = dx * dx + dy * dy + 12.0;
                    
                    if let Some(other_body) = node.body {
                        if other_body != i {
                            let force = repulsion_strength / dist2;
                            fx[i] += (dx / dist2) * force;
                            fy[i] += (dy / dist2) * force;
                            
                            let rj = self.r[other_body];
                            if (br + rj) > 0.0 {
                                let push = (br + rj) * 0.02;
                                let root = (1.0 + dist2 / 1600.0).sqrt();
                                fx[i] += dx.signum() * push / root;
                                fy[i] += dy.signum() * push / root;
                            }
                        }
                        continue;
                    }
                    
                    let size2 = node.size * node.size;
                    if size2 / dist2 < theta2 {
                        let force = (repulsion_strength * node.mass) / dist2;
                        fx[i] += (dx / dist2) * force;
                        fy[i] += (dy / dist2) * force;
                    } else {
                        for &child in &node.children {
                            if child != 0 {
                                stack.push(child);
                            }
                        }
                    }
                }
            }

            // 3. Calculate Link Forces
            for i in 0..self.source_indices.len() {
                let s = self.source_indices[i];
                let t = self.target_indices[i];
                let dx = self.positions[t * 2] - self.positions[s * 2];
                let dy = self.positions[t * 2 + 1] - self.positions[s * 2 + 1];
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let diff = dist - desired_link_length;
                let spring = diff * link_strength;
                let nx = (dx / dist) * spring;
                let ny = (dy / dist) * spring;

                fx[s] -= nx;
                fy[s] -= ny;
                fx[t] += nx;
                fy[t] += ny;
            }

            // 4. Apply Forces and Integrate
            for i in 0..n {
                if self.loc_strength[i] > 0.0 {
                    fx[i] += (self.loc_x[i] - self.positions[i * 2]) * 0.003 * self.loc_strength[i];
                    fy[i] += (self.loc_y[i] - self.positions[i * 2 + 1]) * 0.003 * self.loc_strength[i];
                } else {
                    fx[i] += (self.width / 2.0 - self.positions[i * 2]) * 0.004;
                    fy[i] += (self.height / 2.0 - self.positions[i * 2 + 1]) * 0.004;
                }

                self.velocities[i * 2] = (self.velocities[i * 2] + fx[i] * 0.02) * damping;
                self.velocities[i * 2 + 1] = (self.velocities[i * 2 + 1] + fy[i] * 0.02) * damping;
                
                self.positions[i * 2] += self.velocities[i * 2];
                self.positions[i * 2 + 1] += self.velocities[i * 2 + 1];
            }
        }
    }

    pub fn get_positions(&self) -> Vec<f64> {
        self.positions.clone()
    }
}
