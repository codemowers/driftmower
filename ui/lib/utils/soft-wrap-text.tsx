import { Fragment } from "react"

export function softWrapText(text: string) {
  const segments = text.split(/(?<=[-./])/)
  return segments.map((segment, i) => (
    <Fragment key={i}>
      {segment}
      {i < segments.length - 1 && <wbr />}
    </Fragment>
  ))
}
