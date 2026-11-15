//! 可复现的确定性伪随机数（避免引入 rand 版本差异导致的输出不稳定）。

#[derive(Debug, Clone)]
pub struct Rng {
    state: u64,
    spare: Option<f64>,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407), spare: None }
    }

    pub fn next_u64(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// [0, 1)
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// 标准正态（Box-Muller）
    pub fn normal(&mut self) -> f64 {
        if let Some(s) = self.spare.take() {
            return s;
        }
        let mut u = 0.0;
        while u <= 1e-12 {
            u = self.next_f64();
        }
        let v = self.next_f64();
        let r = (-2.0 * u.ln()).sqrt();
        let theta = std::f64::consts::TAU * v;
        self.spare = Some(r * theta.sin());
        r * theta.cos()
    }

    /// [lo, hi)
    pub fn range_i64(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % ((hi - lo) as u64)) as i64
    }

    pub fn range_u64(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + self.next_u64() % (hi - lo)
    }

    /// 以概率 p 返回 true
    pub fn chance(&mut self, p: f64) -> bool {
        self.next_f64() < p
    }

    /// 从切片随机取一个
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        let i = (self.next_u64() % items.len().max(1) as u64) as usize;
        &items[i.min(items.len().saturating_sub(1))]
    }

    /// 按 tick 取整
    pub fn round_tick(&mut self, px: f64, tick: f64) -> f64 {
        (px / tick).round() * tick
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn normal_moments() {
        let mut r = Rng::new(7);
        let n = 20000;
        let xs: Vec<f64> = (0..n).map(|_| r.normal()).collect();
        let mean = xs.iter().sum::<f64>() / n as f64;
        let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
        assert!(mean.abs() < 0.05, "mean={}", mean);
        assert!((var - 1.0).abs() < 0.1, "var={}", var);
    }
}
