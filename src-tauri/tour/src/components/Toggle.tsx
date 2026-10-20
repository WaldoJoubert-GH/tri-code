export function Toggle(props: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  );
}
