/* FacaParking MVC - VISTA / helpers de presentación */
(function(window){
  'use strict';
  window.FPView={
    text:function(id,value){const e=document.getElementById(id);if(e)e.textContent=value??''},
    show:function(id){const e=document.getElementById(id);if(e)e.style.display=''},
    hide:function(id){const e=document.getElementById(id);if(e)e.style.display='none'},
    message:function(id,value){const e=document.getElementById(id);if(e)e.textContent=value??''}
  };
})(window);
