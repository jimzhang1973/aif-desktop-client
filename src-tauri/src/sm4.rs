//! SM4 国密分组密码（GB/T 32907-2016）纯 Rust 实现。
//! 用途：「我的」页多网址凭据保险库——以网址为 key 的密码加密存储（ECB + PKCS7）。
//! 无第三方依赖；正确性由标准测试向量保证（见 tests）。

const SBOX: [u8; 256] = [
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
    0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
    0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
    0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
    0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
    0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
    0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
    0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
    0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
    0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
    0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
    0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
    0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
    0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
    0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
    0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
];

/// 系统参数 FK
const FK: [u32; 4] = [0xA3B1_BAC6, 0x56AA_3350, 0x677D_9197, 0xB270_22DC];

#[inline]
fn tau(x: u32) -> u32 {
    let b = x.to_be_bytes();
    u32::from_be_bytes([
        SBOX[b[0] as usize],
        SBOX[b[1] as usize],
        SBOX[b[2] as usize],
        SBOX[b[3] as usize],
    ])
}

/// 加密轮的线性变换 L
#[inline]
fn l_enc(b: u32) -> u32 {
    b ^ b.rotate_left(2) ^ b.rotate_left(10) ^ b.rotate_left(18) ^ b.rotate_left(24)
}

/// 密钥扩展的线性变换 L'
#[inline]
fn l_key(b: u32) -> u32 {
    b ^ b.rotate_left(13) ^ b.rotate_left(23)
}

/// 轮常量 CK[i] = ((4i+j)*7 mod 256) 拼接（程序化推导，避免手抄 32 项出错）
#[inline]
fn ck(i: usize) -> u32 {
    let b: [u8; 4] = core::array::from_fn(|j| (((4 * i + j) * 7) % 256) as u8);
    u32::from_be_bytes(b)
}

/// 32 轮子密钥
fn expand_key(key: &[u8; 16]) -> [u32; 32] {
    let mut k = [
        u32::from_be_bytes([key[0], key[1], key[2], key[3]]) ^ FK[0],
        u32::from_be_bytes([key[4], key[5], key[6], key[7]]) ^ FK[1],
        u32::from_be_bytes([key[8], key[9], key[10], key[11]]) ^ FK[2],
        u32::from_be_bytes([key[12], key[13], key[14], key[15]]) ^ FK[3],
    ];
    let mut rks = [0u32; 32];
    for i in 0..32 {
        let nk = k[0] ^ l_key(tau(k[1] ^ k[2] ^ k[3] ^ ck(i)));
        rks[i] = nk;
        k = [k[1], k[2], k[3], nk];
    }
    rks
}

/// 单块加/解密（解密 = 逆序子密钥，轮函数相同）
fn crypt_block(block: &[u8; 16], rks: &[u32; 32]) -> [u8; 16] {
    let mut x = [
        u32::from_be_bytes([block[0], block[1], block[2], block[3]]),
        u32::from_be_bytes([block[4], block[5], block[6], block[7]]),
        u32::from_be_bytes([block[8], block[9], block[10], block[11]]),
        u32::from_be_bytes([block[12], block[13], block[14], block[15]]),
    ];
    for i in 0..32 {
        let nx = x[0] ^ l_enc(tau(x[1] ^ x[2] ^ x[3] ^ rks[i]));
        x = [x[1], x[2], x[3], nx];
    }
    let mut out = [0u8; 16];
    for (j, w) in x.iter().rev().enumerate() {
        out[j * 4..j * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    out
}

/// SM4-ECB + PKCS7 加密
pub fn encrypt_ecb(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    let rks = expand_key(key);
    let pad = 16 - (plain.len() % 16);
    let mut data = plain.to_vec();
    data.resize(plain.len() + pad, pad as u8);
    for chunk in data.chunks_mut(16) {
        let block: [u8; 16] = chunk.try_into().unwrap();
        chunk.copy_from_slice(&crypt_block(&block, &rks));
    }
    data
}

/// SM4-ECB + PKCS7 解密（填充非法时报错）
pub fn decrypt_ecb(key: &[u8; 16], cipher: &[u8]) -> Result<Vec<u8>, String> {
    if cipher.is_empty() || cipher.len() % 16 != 0 {
        return Err("SM4 密文长度非法".into());
    }
    let mut rks = expand_key(key);
    rks.reverse();
    let mut data = Vec::with_capacity(cipher.len());
    for chunk in cipher.chunks(16) {
        let block: [u8; 16] = chunk.try_into().unwrap();
        data.extend_from_slice(&crypt_block(&block, &rks));
    }
    let pad = *data.last().ok_or("SM4 密文为空")? as usize;
    if pad == 0 || pad > 16 || data.len() < pad || data[data.len() - pad..].iter().any(|b| *b as usize != pad) {
        return Err("SM4 解密失败：填充校验不通过（密钥不匹配或数据损坏）".into());
    }
    data.truncate(data.len() - pad);
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GB/T 32907-2016 标准示例：key=plain=0123456789abcdeffedcba9876543210
    /// → 密文 681edf34d206965e86b3e94f536e4246
    #[test]
    fn standard_vector() {
        let key: [u8; 16] = [
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
        ];
        let plain = key;
        let rks = expand_key(&key);
        let out = crypt_block(&plain, &rks);
        let expect: [u8; 16] = [
            0x68, 0x1e, 0xdf, 0x34, 0xd2, 0x06, 0x96, 0x5e, 0x86, 0xb3, 0xe9, 0x4f, 0x53, 0x6e, 0x42, 0x46,
        ];
        assert_eq!(out, expect);
    }

    #[test]
    fn ecb_roundtrip() {
        let key = [7u8; 16];
        for len in [1usize, 15, 16, 17, 64] {
            let plain: Vec<u8> = (0..len).map(|i| (i * 31 + 5) as u8).collect();
            let cipher = encrypt_ecb(&key, &plain);
            assert_eq!(cipher.len(), (len / 16 + 1) * 16);
            assert_eq!(decrypt_ecb(&key, &cipher).unwrap(), plain);
        }
    }

    #[test]
    fn wrong_key_fails() {
        let cipher = encrypt_ecb(&[1u8; 16], b"secret-password");
        assert!(decrypt_ecb(&[2u8; 16], &cipher).is_err());
    }
}
