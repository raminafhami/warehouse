declare module "*.module.css" {
  const styles: Record<string, string>;
  export default styles;
}
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.webp" {
  const url: string;
  export default url;
}
