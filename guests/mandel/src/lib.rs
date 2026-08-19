//! A real Rust workload for Weave: escape-time fractal over a grid, with a
//! rolling FNV checksum and progress emission through a host service.
//! Built for wasm32-unknown-unknown with no WASI and no std I/O.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

extern "C" {
    fn emit(i: i32, h: i64);
}

const W: usize = 512;
const H: usize = 512;

static mut GRID: [u8; W * H] = [0; W * H];

fn escape_time(cx: f64, cy: f64, max: u32) -> u32 {
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut i = 0;
    while i < max {
        let x2 = x * x - y * y + cx;
        y = 2.0 * x * y + cy;
        x = x2;
        if x * x + y * y > 4.0 {
            break;
        }
        i += 1;
    }
    i
}

/// Render `frames` slightly-zoomed fractal frames; emit (frame*rows+row, hash)
/// progress every 64 rows; return the final checksum.
#[no_mangle]
pub extern "C" fn render(frames: i32) -> i64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for f in 0..frames {
        let zoom = 1.0 + f as f64 * 0.03;
        let (ox, oy) = (-0.7436, 0.1318);
        for row in 0..H {
            for col in 0..W {
                let cx = ox + (col as f64 / W as f64 - 0.5) * 3.0 / zoom;
                let cy = oy + (row as f64 / H as f64 - 0.5) * 3.0 / zoom;
                let t = escape_time(cx, cy, 96) as u8;
                unsafe {
                    GRID[row * W + col] = t;
                }
                hash ^= t as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
            if row % 64 == 0 {
                unsafe { emit(f * H as i32 + row as i32, hash as i64) };
            }
        }
        // fold the rendered frame back into the hash: this forces the frame
        // buffer to be live memory (and gives pre-copy real state to move)
        for row in 0..H {
            for col in 0..W {
                hash ^= unsafe { GRID[row * W + col] } as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    hash as i64
}
