import { fault, record } from './protocol';

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

export function terminalDimensions(value: unknown): TerminalDimensions {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'columns' && key !== 'rows') ||
    typeof value.columns !== 'number' ||
    typeof value.rows !== 'number' ||
    !Number.isInteger(value.columns) ||
    !Number.isInteger(value.rows) ||
    value.columns < 1 ||
    value.columns > 65535 ||
    value.rows < 1 ||
    value.rows > 65535
  )
    throw fault('EINVAL', 'Terminal columns and rows must be integers from 1 to 65535');
  return { columns: value.columns, rows: value.rows };
}
