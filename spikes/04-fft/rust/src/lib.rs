use realfft::{num_complex::Complex, RealFftPlanner, RealToComplex};
use std::sync::Arc;
pub struct Plan { fft: Arc<dyn RealToComplex<f32>>, scratch: Vec<Complex<f32>>, n: usize }
#[no_mangle]
pub extern "C" fn rfft_new(n: usize) -> *mut Plan {
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n);
    let scratch = fft.make_scratch_vec();
    Box::into_raw(Box::new(Plan { fft, scratch, n }))
}
/// The input is used as scratch space and destroyed.
#[no_mangle]
pub unsafe extern "C" fn rfft_exec(p: *mut Plan, input: *mut f32, output: *mut Complex<f32>) -> i32 {
    let p = &mut *p;
    let i = std::slice::from_raw_parts_mut(input, p.n);
    let o = std::slice::from_raw_parts_mut(output, p.n / 2 + 1);
    p.fft.process_with_scratch(i, o, &mut p.scratch).is_err() as i32
}
