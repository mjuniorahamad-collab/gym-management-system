/**
 * Accessible wrapper for a recharts figure.
 *
 * recharts renders an SVG with no text alternative, so a screen-reader user
 * previously got nothing at all for "Cash flow", "Member growth" and "Expenses
 * by category". This exposes the chart as an image with a summary label AND
 * provides the underlying figures as a visually hidden table, so the numbers
 * are actually reachable rather than merely described.
 */
export function ChartFrame({ title, description, columns, rows, children }) {
  return (
    <figure role="img" aria-label={title} className="m-0">
      {children}
      <figcaption className="sr-only">{description}</figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c, ci) => (
                <td key={c}>{ci === 0 ? <th scope="row">{row[c]}</th> : row[c]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}