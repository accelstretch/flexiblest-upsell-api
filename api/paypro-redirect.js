export default async function handler(req, res) {
  console.log("PAYPRO REDIRECT METHOD:", req.method);
  console.log("PAYPRO REDIRECT QUERY:", req.query || {});
  console.log("PAYPRO REDIRECT BODY:", req.body || {});

  return res.redirect(
    302,
    "https://flexiblest.com/complete-upgrade"
  );
}
