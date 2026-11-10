//! Public-key-only deployment smoke verifier. Never reads a private key.
fn main(){
 let args:Vec<_>=std::env::args().skip(1).collect();if args.len()!=4{eprintln!("Usage: verify-signature payload signature public-key expected-version");std::process::exit(2)}
 let data=std::fs::read(&args[0]).expect("payload readable");let signature=std::fs::read_to_string(&args[1]).expect("signature readable");let public=std::fs::read_to_string(&args[2]).expect("public key readable");
 if portable_update_common::signature::verify_payload(&data,&signature,&public,&args[3]).is_err(){eprintln!("Signature or signed version rejected");std::process::exit(1)}println!("Signature and signed version verified")
}
