(function (root) {
  "use strict";
  root.EnjoyInvitations = {
    url(token) {
      return (
        location.origin +
        (root.EnjoyDemo ? "/enjoy/demo" : "/enjoy/inventarios") +
        "#unirse/" +
        encodeURIComponent(token)
      );
    },
    svg(url) {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return qr.createSvgTag({
        cellSize: 5,
        margin: 20,
        scalable: true,
        alt: "QR para unirse al inventario",
      });
    },
  };
})(window);
