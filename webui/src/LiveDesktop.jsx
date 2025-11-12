export default function LiveDesktop() {
  const src = `http://${location.hostname}:6080/`;
  return (
    <iframe
      src={src}
      title="Desktop"
      style={{ width: '100%', height: '80vh', borderRadius: 12, border: '1px solid #ccc' }}
    />
  );
}

