/** @param {{ page: number, count: number, onPage: (page: number) => void }} props */
export function Pagination({ page, count, onPage }) {
  const pages = Math.max(1, Math.ceil(count / 12));
  return (
    <div className="pagination">
      <span>{count.toLocaleString("fa")} نتیجه</span>
      <button disabled={page === 0} onClick={() => onPage(page - 1)}>
        قبلی
      </button>
      <span>
        صفحهٔ {(page + 1).toLocaleString("fa")} از {pages.toLocaleString("fa")}
      </span>
      <button disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
        بعدی
      </button>
    </div>
  );
}
