export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: 'fail' | 'ok' | 'warn';
}
